import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Live } from '../src/live';
import { createApp } from '../src/server';
import { Sessions } from '../src/sessions';
import { Settings } from '../src/settings';
import { Usage } from '../src/usage';
import { qrSVG } from '../src/share';
import { mountWeb } from '../src/web';
import { fakePlex } from './helpers';

const KEY = 'sk-ant-api03-very-secret-key-wxyz';

/** How a provider answers Settings' sample request. */
const sampleAnswer = () =>
	Response.json({
		choices: [
			{
				finish_reason: 'stop',
				message: {
					content: JSON.stringify({
						minimums: { critics: null, audience: null, imdb: null },
						picks: [{ id: '1', reason: 'Gags.' }],
						suggestions: [{ title: 'Top Secret!', year: 1984, discoverId: null, reason: 'Same team.' }],
					}),
				},
			},
		],
		usage: { prompt_tokens: 900, completion_tokens: 60 },
	});

/** Athena with fake Plex, where the PIN `pin` is approved by whoever `approve` says. */
function athena(saved: Parameters<Settings['save']>[0] = {}, env: Record<string, string> = {}) {
	const plex = fakePlex();
	let approve: string | null = null;
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		if (path === '/api/v2/pins' && init?.method === 'POST') return Response.json({ id: 7, code: 'abc' });
		if (path === '/api/v2/pins/7') return Response.json({ id: 7, authToken: approve });
		const key = new Headers(init?.headers).get('Authorization');
		if (String(url) === 'https://api.openai.com/v1/chat/completions') {
			if (key !== 'Bearer sk-openai') return new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 });
			if (JSON.parse(String(init?.body)).model === 'gpt-6.2-astra')
				return new Response('{"error":{"message":"The model `gpt-6.2-astra` does not exist."}}', { status: 404 });
			return sampleAnswer();
		}
		if (String(url) === 'http://ollama:11434/v1/models') return Response.json({ data: [{ id: 'llama-test:latest' }] });
		if (String(url) === 'http://ollama:11434/v1/chat/completions') return sampleAnswer();
		return plex.fetcher(url, init);
	}) as typeof fetch;
	const settings = new Settings(mkdtempSync(join(tmpdir(), 'athena-')), env);
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
		expect(status).toContain('Answering for Uranus with Claude Haiku 5.5');
		const settings = await (await get('/settings', cookie)).text();
		expect(settings).toContain('sk-ant-…wxyz');
		expect(settings).not.toContain(KEY);
	});

	test('a key set by the environment shows locked, with what it is for and where to get one', async () => {
		const { get, signIn } = athena(ready, { TYPESAFE_API_KEY: 'ts-env-key-1234' });
		const settings = await (await get('/settings', await signIn('owner-token'))).text();
		expect(settings).toContain('Set by TYPESAFE_API_KEY');
		expect(settings).toContain('Jev is TypeSafe&#39;s decision model.');
		expect(settings).toContain('href="https://console.typesafe.ai/"');
		expect(settings).not.toContain('ts-env-key-1234');
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
		const response = await post(
			'/settings',
			{ server: 'machine-1', provider: 'anthropic', model_anthropic: 'claude-sonnet-5-5', typesafeKey: 'ts-key', dailyLimit: '' },
			cookie,
		);
		expect(response.status).toBe(303);
		expect(live.model).toBe('claude-sonnet-5-5');
		expect(live.jevKey).toBe('ts-key');
		expect(live.dailyLimit).toBeNull();
		expect(live.effective.anthropicKey).toBe(KEY);
		await post('/settings', { server: 'machine-1', anthropicKeyRemove: '1' }, cookie);
		expect(live.ai).toBeNull();
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

describe('sharing with friends', () => {
	const ready = { server: { id: 'machine-1', name: 'Uranus' }, anthropicKey: KEY };

	test('the owner sets a public address, https only, and the owner is named for the daily limit', async () => {
		const { live, post, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const bad = await post('/settings', { server: 'machine-1', publicURL: 'http://athena.example.com' }, cookie);
		expect(bad.headers.get('Location')).toContain('problem=');
		expect(live.effective.publicURL).toBeNull();
		await post('/settings', { server: 'machine-1', publicURL: 'https://Athena.Example.com/' }, cookie);
		expect(live.effective.publicURL).toBe('https://athena.example.com');
		expect(live.ownerName).toBe('Owner');
		await post('/settings', { server: 'machine-1', publicURL: '' }, cookie);
		expect(live.effective.publicURL).toBeNull();
	});

	test('the share page gives the link to copy, its QR code and the address to type on Apple TV', async () => {
		const { get, signIn } = athena({ ...ready, publicURL: 'https://athena.example.com' });
		const page = await (await get('/share', await signIn('owner-token'))).text();
		expect(page).toContain('value="ithaca://athena?url=https%3A%2F%2Fathena.example.com"');
		expect(page).toContain('data-copy="share-link"');
		expect(page).toContain('<svg');
		expect(page).toContain('<p class="address">https://athena.example.com</p>');
		expect(page).toContain(qrSVG('ithaca://athena?url=https%3A%2F%2Fathena.example.com'));
	});

	test('without a public address, the share page says Athena is home-only', async () => {
		const { get, signIn } = athena(ready);
		const page = await (await get('/share', await signIn('owner-token'))).text();
		expect(page).toContain('home-only');
		expect(page).not.toContain('ithaca://');
	});

	test('only the owner opens the share page', async () => {
		const { get, signIn } = athena({ ...ready, publicURL: 'https://athena.example.com' });
		expect((await get('/share', await signIn('friend-token'))).headers.get('Location')).toBe('/');
	});

	test("the status page lists each person's Describe Its today, against the limit for all but the owner, and this month with spend", async () => {
		const { usage, get, signIn } = athena({ ...ready, dailyLimit: 2 });
		const row = { kind: 'movie', picks: 9, suggestions: 0, by: 'jev', ms: 250, status: 200, error: null, inputTokens: 1, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0.02 };
		usage.record({ ...row, viewerId: '1001', viewer: 'Owner', request: 'funny' });
		usage.record({ ...row, viewerId: '1002', viewer: 'friend', request: 'funny' });
		usage.record({ ...row, viewerId: '1002', viewer: 'friend', request: 'scary' });
		const page = await (await get('/', await signIn('owner-token'))).text();
		expect(page).toContain('By person');
		expect(page).toMatch(
			/<li class="full"><span class="person">friend<\/span><span class="figures"><span class="count today"><strong>2<\/strong> of 2 today<\/span><span class="count"><strong>2<\/strong> this month, <strong>\$0.04<\/strong>/,
		);
		expect(page).toMatch(/Owner<span class="you">you, no limit<\/span><\/span><span class="figures"><span class="count today"><strong>1<\/strong> today<\/span>/);
	});
});

describe('choosing the AI model', () => {
	const ready = { server: { id: 'machine-1', name: 'Uranus' }, anthropicKey: KEY };

	test('settings offer every provider, each tier with its price and about what a Describe It costs', async () => {
		const { usage, get, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const page = await (await get('/settings', cookie)).text();
		for (const name of ['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Local model']) expect(page).toContain(name);
		expect(page).toMatch(/GPT-6.2 Sol<\/span><small>\$2 in, \$10 out per million tokens<\/small><\/span><span class="tier-cost"><strong>12¢<\/strong>/);
		expect(page).toMatch(/Claude Haiku 5.5<\/span><small>\$0.10 in, \$0.50 out per million tokens<\/small><\/span><span class="tier-cost"><strong>0.6¢/);
		expect(page).toContain('about 29K tokens for 600 titles');
		const row = { viewerId: '1002', viewer: 'friend', kind: 'movie', request: 'funny', picks: 9, suggestions: 0, by: 'claude-haiku-5-5', ms: 1, status: 200, error: null, outputTokens: 400, cacheRead: 0, cacheWrite: 0, cost: 0 };
		for (const request of ['a', 'b', 'c']) usage.record({ ...row, request, inputTokens: 100_000 });
		const measured = await (await get('/settings', cookie)).text();
		expect(measured).toContain('about 100K tokens going by your recent requests');
	});

	test("the owner switches to OpenAI's Balanced tier, which answers at once, and the Anthropic key stays", async () => {
		const { app, live, get, post, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		await post('/settings', { server: 'machine-1', provider: 'openai', openaiKey: 'sk-openai', model_openai: 'gpt-6.2-sol' }, cookie);
		expect(live.ai?.by).toBe('gpt-6.2-sol');
		expect(live.effective.anthropicKey).toBe(KEY);
		expect(await (await get('/', cookie)).text()).toContain('Answering for Uranus with GPT-6.2 Sol');
		expect(await (await app.request('/healthz')).json()).toMatchObject({ ready: true, provider: 'openai', model: 'gpt-6.2-sol' });
	});

	test('a local model needs its address and its name on that server', async () => {
		const { live, post, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const bad = await post('/settings', { server: 'machine-1', provider: 'local', localURL: 'nope', model_local: 'llama-test' }, cookie);
		expect(bad.headers.get('Location')).toContain('problem=');
		await post('/settings', { server: 'machine-1', provider: 'local', localURL: 'http://ollama:11434', model_local: '' }, cookie);
		expect(live.ai).toBeNull();
		await post('/settings', { server: 'machine-1', provider: 'local', localURL: 'http://ollama:11434', model_local: 'llama-test' }, cookie);
		expect(live.ai?.by).toBe('local:llama-test');
		expect(live.effective.localURL).toBe('http://ollama:11434/v1');
	});

	test("Test sends a sample Describe It through the chosen model, and lists a local server's models", async () => {
		const { post, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const test = async (fields: Record<string, string>) =>
			(await (await post('/settings/test', fields, cookie)).json()) as { ok: boolean; message: string; models?: string[] };
		const works = await test({ provider: 'openai', openaiKey: 'sk-openai', model: 'gpt-6.2-sol' });
		expect(works.ok).toBe(true);
		expect(works.message).toStartWith('Works. GPT-6.2 Sol picked Airplane! and suggested Top Secret! for "something funny and short"');
		expect(await test({ provider: 'openai', openaiKey: 'sk-openai', model: 'gpt-6.2-astra' })).toEqual({
			ok: false,
			message: 'GPT returned an error (404): The model `gpt-6.2-astra` does not exist.',
		});
		expect(await test({ provider: 'openai', openaiKey: 'wrong', model: 'gpt-6-luna' })).toEqual({
			ok: false,
			message: "Athena's OpenAI API key was rejected.",
		});
		expect(await test({ provider: 'local', localURL: 'http://ollama:11434', model: 'nope' })).toEqual({
			ok: false,
			message: 'Reached it, but it has no nope. Its models: llama-test:latest.',
			models: ['llama-test:latest'],
		});
		const local = await test({ provider: 'local', localURL: 'http://ollama:11434', model: 'llama-test' });
		expect(local).toMatchObject({ ok: true, models: ['llama-test:latest'] });
		expect(local.message).toContain('llama-test (local) picked Airplane!');
	});

	test('before setup, Test is only for someone who owns a Plex server, since it spends the key', async () => {
		const { post, signIn } = athena({}, { OPENAI_API_KEY: 'sk-openai', ATHENA_PROVIDER: 'openai' });
		const friend = await post('/settings/test', { provider: 'openai', model: 'gpt-6-luna' }, await signIn('friend-token'));
		expect(friend.status).toBe(403);
		const owner = await post('/settings/test', { provider: 'openai', model: 'gpt-6-luna' }, await signIn('owner-token'));
		expect(((await owner.json()) as { ok: boolean }).ok).toBe(true);
	});

	test('with the provider set by ATHENA_PROVIDER, the tier or local model saved is the one used', async () => {
		const cloud = athena(ready, { ATHENA_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-openai' });
		await cloud.post('/settings', { server: 'machine-1', model_openai: 'gpt-6.2-sol' }, await cloud.signIn('owner-token'));
		expect(cloud.live.ai?.by).toBe('gpt-6.2-sol');
		const local = athena(ready, { ATHENA_PROVIDER: 'local' });
		await local.post(
			'/settings',
			{ server: 'machine-1', localURL: 'http://ollama:11434', model_local: 'llama-test' },
			await local.signIn('owner-token'),
		);
		expect(local.live.ai?.by).toBe('local:llama-test');
	});

	test("Test refuses a local address Save would refuse, rather than trying the saved one", async () => {
		const { post, signIn } = athena({ ...ready, provider: 'local', localURL: 'http://ollama:11434/v1', model: 'llama-test' });
		const answer = await post('/settings/test', { provider: 'local', localURL: 'ftp://new-server', model: 'llama-test' }, await signIn('owner-token'));
		expect(await answer.json()).toEqual({
			ok: false,
			message: "The local model's address is an http:// address, such as http://192.168.1.10:11434/v1.",
		});
	});
});
