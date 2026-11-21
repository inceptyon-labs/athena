import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Live } from '../src/live';
import { createApp } from '../src/server';
import { Sessions } from '../src/sessions';
import { Settings } from '../src/settings';
import { Usage } from '../src/usage';
import { mountWeb } from '../src/web';
import { fakePlex } from './helpers';

const KEY = 'sk-ant-api03-very-secret-key-wxyz';

/** Athena with fake Plex, where the PIN `pin` is approved by whoever `approve` says. */
function athena(saved: Parameters<Settings['save']>[0] = {}) {
	const plex = fakePlex();
	let approve: string | null = null;
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		if (path === '/api/v2/pins' && init?.method === 'POST') return Response.json({ id: 7, code: 'abc' });
		if (path === '/api/v2/pins/7') return Response.json({ id: 7, authToken: approve });
		return plex.fetcher(url, init);
	}) as typeof fetch;
	const settings = new Settings(mkdtempSync(join(tmpdir(), 'athena-')), {});
	settings.save(saved);
	const live = new Live(settings, fetcher);
	const usage = new Usage(':memory:');
	const app = createApp(Object.assign(live, { usage }));
	mountWeb(app, { live, usage, sessions: new Sessions() });

	const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
	const post = (path: string, fields: Record<string, string>, cookie = '', origin = 'http://athena:8800') =>
		app.request(`http://athena:8800${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: origin, Host: 'athena:8800' },
			body: form(fields),
		});
	const get = (path: string, cookie = '') => app.request(`http://athena:8800${path}`, { headers: { Cookie: cookie, Host: 'athena:8800' } });

	/** Signs in as the account with this Plex token and returns the session cookie. */
	async function signIn(token: string) {
		const start = await post('/signin', {});
		const pin = start.headers.get('Set-Cookie')?.split(';')[0] ?? '';
		approve = token;
		const done = await get('/signin/done', pin);
		const session = done.headers.getSetCookie().find((cookie) => cookie.startsWith('athena_session='));
		return session?.split(';')[0] ?? '';
	}
	return { app, live, usage, post, get, signIn, setApprove: (token: string | null) => (approve = token) };
}

describe('sign in with Plex', () => {
	test("the button sends the viewer to Plex's own page, which comes back to Athena", async () => {
		const { post } = athena();
		const response = await post('/signin', {});
		expect(response.status).toBe(303);
		const location = response.headers.get('Location') ?? '';
		expect(location.startsWith('https://app.plex.tv/auth#?')).toBe(true);
		const query = new URLSearchParams(location.split('#?')[1]);
		expect(query.get('code')).toBe('abc');
		expect(query.get('forwardUrl')).toBe('http://athena:8800/signin/done');
		expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
	});

	test('until Plex confirms, the page waits; then the viewer is signed in', async () => {
		const { post, get, setApprove } = athena();
		const pin = (await post('/signin', {})).headers.get('Set-Cookie')?.split(';')[0] ?? '';
		const waiting = await get('/signin/done', pin);
		expect(await waiting.text()).toContain('Waiting for Plex');
		setApprove('owner-token');
		const done = await get('/signin/done', pin);
		expect(done.status).toBe(303);
		expect(done.headers.getSetCookie().some((cookie) => cookie.startsWith('athena_session='))).toBe(true);
	});

	test("a return from Plex without this browser's sign-in doesn't sign anyone in", async () => {
		const { get, setApprove } = athena();
		setApprove('owner-token');
		const response = await get('/signin/done');
		expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('athena_session='))).toBe(false);
	});

	test('a form posted from another site is refused', async () => {
		const { post } = athena();
		expect((await post('/signin', {}, '', 'https://evil.example')).status).toBe(403);
	});
});

describe('who sees what', () => {
	const ready = { server: { id: 'machine-1', name: 'Uranus' }, anthropicKey: KEY, dailyLimit: 5 };

	test('the owner gets the status page and settings, never a key in full', async () => {
		const { get, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const status = await (await get('/', cookie)).text();
		expect(status).toContain('Answering for Uranus with Haiku 5.5');
		const settings = await (await get('/settings', cookie)).text();
		expect(settings).toContain('sk-ant-…wxyz');
		expect(settings).not.toContain(KEY);
	});

	test('a friend sees their own use, and settings are closed to them', async () => {
		const { live, get, post, signIn } = athena(ready);
		const cookie = await signIn('friend-token');
		const page = await (await get('/', cookie)).text();
		expect(page).toContain('of 5 Describe Its today');
		expect((await get('/settings', cookie)).status).toBe(303);
		await post('/settings', { server: 'machine-1', anthropicKey: 'sk-ant-stolen', dailyLimit: '' }, cookie);
		expect(live.effective.anthropicKey).toBe(KEY);
	});

	test("someone the server isn't shared with is told so", async () => {
		const { get, signIn } = athena(ready);
		const page = await (await get('/', await signIn('stranger'))).text();
		expect(page).toContain('No access');
	});

	test('the owner saves settings, which apply without a restart', async () => {
		const { live, post, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const response = await post('/settings', { server: 'machine-1', model: 'claude-sonnet-5-5', typesafeKey: 'ts-key', dailyLimit: '' }, cookie);
		expect(response.status).toBe(303);
		expect(live.model).toBe('claude-sonnet-5-5');
		expect(live.jevKey).toBe('ts-key');
		expect(live.dailyLimit).toBeNull();
		expect(live.effective.anthropicKey).toBe(KEY);
		await post('/settings', { server: 'machine-1', anthropicKeyRemove: '1' }, cookie);
		expect(live.client).toBeNull();
	});

	test('before any server is chosen, whoever signs in sets Athena up with a server they own', async () => {
		const { live, get, post, signIn } = athena();
		const cookie = await signIn('owner-token');
		expect((await get('/', cookie)).headers.get('Location')).toBe('/settings');
		const page = await (await get('/settings', cookie)).text();
		expect(page).toContain('Set up Athena');
		expect(page).toContain('Uranus');
		expect(page).not.toContain('Other');
		await post('/settings', { server: 'other-server', anthropicKey: KEY }, cookie);
		expect(live.gate).toBeNull();
		const done = await post('/settings', { server: 'machine-1', anthropicKey: KEY }, cookie);
		expect(done.headers.get('Location')).toBe('/');
		expect(live.effective.server).toEqual({ id: 'machine-1', name: 'Uranus' });
	});
});
