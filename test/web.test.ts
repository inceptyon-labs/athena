import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cutter } from '../src/clips';
import { JOBS, Runner } from '../src/jobs';
import type { AI } from '../src/pick';
import { Live } from '../src/live';
import { createApp } from '../src/server';
import { Sessions } from '../src/sessions';
import { Settings } from '../src/settings';
import { Usage } from '../src/usage';
import { qrSVG } from '../src/share';
import { type Door, mountWeb } from '../src/web';
import { fakeAbs, fakePlex } from './helpers';

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
function athena(saved: Parameters<Settings['save']>[0] = {}, env: Record<string, string> = {}, jobs: { ai?: AI; cutter?: Cutter } = {}) {
	const plex = fakePlex();
	const abs = fakeAbs();
	const scribed: FormData[] = [];
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
		if (String(url).startsWith('http://abs:13378/')) return abs.fetcher(url, init);
		if (String(url) === 'https://api.elevenlabs.io/v1/speech-to-text') {
			if (new Headers(init?.headers).get('xi-api-key') !== 'eleven-fake-0000') return new Response('', { status: 401 });
			scribed.push(init?.body as FormData);
			return Response.json({ text: scribed.length === 1 ? 'Chapter one. The Watsons.' : 'Chapter two. Mr Knightley.' }, { headers: { 'character-cost': '4' } });
		}
		if (String(url) === 'https://api.elevenlabs.io/v1/user/subscription')
			return Response.json({ tier: 'starter', character_count: 843, character_limit: 80_339, next_character_count_reset_unix: 1_798_053_805 });
		if (String(url).startsWith('https://api.elevenlabs.io/v1/usage/character-stats')) return Response.json({ usage: { STT: [0, 206] } });
		return plex.fetcher(url, init);
	}) as typeof fetch;
	const settings = new Settings(mkdtempSync(join(tmpdir(), 'athena-')), env);
	settings.save(saved);
	const live = new Live(settings, fetcher);
	const usage = new Usage(':memory:');
	const app = createApp(Object.assign(live, { usage }));
	const runner = new Runner(':memory:', JOBS, () => ({
		abs: live.abs,
		region: live.audibleRegion,
		auto: (id) => live.autoJobs.includes(id),
		speech: live.speech,
		ai: jobs.ai ?? live.ai,
		...(jobs.cutter ? { cutter: jobs.cutter } : {}),
	}));
	const sessions = new Sessions();
	mountWeb(app, { live, usage, runner, sessions });

	/** The owner at home on the admin port, unless a test says otherwise. */
	const HOME: Door = { surface: 'admin', peer: '127.0.0.1' };
	/** The session's form token, which Athena's own forms carry. */
	const tokenOf = (cookie: string) => sessions.get(cookie.split('=')[1])?.form ?? '';
	const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
	const post = (
		path: string,
		fields: Record<string, string>,
		cookie = '',
		origin = 'http://athena:8800',
		door: Door = HOME,
		headers: Record<string, string> = {},
	) =>
		app.request(
			`http://athena:8800${path}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: origin, Host: 'athena:8800', ...headers },
				body: form({ _token: tokenOf(cookie), ...fields }),
			},
			door,
		);
	const get = (path: string, cookie = '', door: Door = HOME, headers: Record<string, string> = {}) =>
		app.request(`http://athena:8800${path}`, { headers: { Cookie: cookie, Host: 'athena:8800', ...headers } }, door);

	/** Signs in as the account with this Plex token and returns the session cookie. */
	async function signIn(token: string) {
		const start = await post('/signin', {});
		const pin = start.headers.get('Set-Cookie')?.split(';')[0] ?? '';
		approve = token;
		const done = await get('/signin/done', pin);
		const session = done.headers.getSetCookie().find((cookie) => cookie.startsWith('athena_session='));
		return session?.split(';')[0] ?? '';
	}
	return { app, live, usage, runner, abs, scribed, post, get, signIn, tokenOf, setApprove: (token: string | null) => (approve = token) };
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
		expect(done.headers.getSetCookie().find((cookie) => cookie.startsWith('athena_session='))).toContain('Max-Age=604800');
	});

	test("a return from Plex without this browser's sign-in doesn't sign anyone in", async () => {
		const { get, setApprove } = athena();
		setApprove('owner-token');
		const response = await get('/signin/done');
		expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('athena_session='))).toBe(false);
	});

	test('a form posted from another site, or from nowhere ("null"), is refused', async () => {
		const { post } = athena();
		expect((await post('/signin', {}, '', 'https://evil.example')).status).toBe(403);
		expect((await post('/signin', {}, '', 'null')).status).toBe(403);
	});

	test("a form without this session's token is refused", async () => {
		const { live, post, signIn } = athena({ server: { id: 'machine-1', name: 'Uranus' }, anthropicKey: KEY });
		const cookie = await signIn('owner-token');
		expect((await post('/settings', { _token: 'guessed', server: 'machine-1', anthropicKey: 'sk-ant-stolen' }, cookie)).status).toBe(403);
		expect((await post('/signout', { _token: '' }, cookie)).status).toBe(403);
		expect(live.effective.anthropicKey).toBe(KEY);
	});

	test('forwarding headers count only from a proxy on the home network', async () => {
		const { post } = athena();
		const signIn = (peer: string) =>
			post('/signin', {}, '', 'https://athena.example.com', { surface: 'public', peer }, {
				'X-Forwarded-Host': 'athena.example.com',
				'X-Forwarded-Proto': 'https',
			});
		const proxied = await signIn('172.18.0.4');
		expect(new URLSearchParams(proxied.headers.get('Location')?.split('#?')[1]).get('forwardUrl')).toBe('https://athena.example.com/signin/done');
		// Straight from the internet the headers are ignored, so the form's origin isn't Athena's own address.
		expect((await signIn('203.0.113.9')).status).toBe(403);
	});
});

describe('settings stay home', () => {
	const ready = { server: { id: 'machine-1', name: 'Uranus' }, anthropicKey: KEY, dailyLimit: 5 };
	/** A request from the internet through a Cloudflare tunnel to the public port. */
	const TUNNEL: Door = { surface: 'public', peer: '172.18.0.4' };
	const CLOUDFLARE = { 'Cf-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '203.0.113.7' };

	test('through a tunnel, the owner gets the status page and Share but not Settings, saving changes nothing, and friends get their page', async () => {
		const { live, get, post, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const settings = await get('/settings', cookie, TUNNEL, CLOUDFLARE);
		expect(settings.status).toBe(403);
		expect(await settings.text()).toContain('Settings are on your home network');
		expect(await (await get('/', cookie, TUNNEL, CLOUDFLARE)).text()).toContain('Answering for Uranus');
		expect((await get('/share', cookie, TUNNEL, CLOUDFLARE)).status).toBe(200);
		expect((await get('/automations', cookie, TUNNEL, CLOUDFLARE)).status).toBe(403);
		const saved = await post('/settings', { server: 'machine-1', anthropicKey: 'sk-ant-new' }, cookie, 'http://athena:8800', TUNNEL, CLOUDFLARE);
		expect(saved.status).toBe(403);
		expect(live.effective.anthropicKey).toBe(KEY);
		const friend = await get('/', await signIn('friend-token'), TUNNEL, CLOUDFLARE);
		expect(await friend.text()).toContain('of 5 Describe Its today');
	});

	test('at home on the public port, an owner page sends the owner on to the admin port', async () => {
		const { get, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const response = await get('/settings?saved', cookie, { surface: 'public', peer: '192.168.1.20' }, { Host: '192.168.1.10:8800' });
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('http://192.168.1.10:8801/settings?saved');
	});

	test('the admin port turns away the internet, even through a proxy with a home address added, but lets a VPN in', async () => {
		const { get, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const spoofed = { 'X-Forwarded-For': '192.168.1.5, 203.0.113.9' };
		expect((await get('/settings', cookie, { surface: 'admin', peer: '172.18.0.4' }, spoofed)).status).toBe(403);
		expect((await get('/settings', cookie, { surface: 'admin', peer: '203.0.113.9' })).status).toBe(403);
		expect((await get('/settings', cookie, { surface: 'admin', peer: '100.101.102.103' })).status).toBe(200);
		expect((await get('/settings', cookie, { surface: 'admin', peer: '172.18.0.4' }, { 'X-Forwarded-For': '192.168.1.5' })).status).toBe(200);
	});

	test('nobody sets Athena up from the internet', async () => {
		const { live, get, post, signIn } = athena();
		const cookie = await signIn('owner-token');
		expect(await (await get('/settings', cookie, TUNNEL, CLOUDFLARE)).text()).toContain('Set Athena up from home');
		expect(await (await get('/', cookie, TUNNEL, CLOUDFLARE)).text()).toContain('Set Athena up from home');
		await post('/settings', { server: 'machine-1', anthropicKey: KEY }, cookie, 'http://athena:8800', TUNNEL, CLOUDFLARE);
		expect(live.effective.server).toBeNull();
	});

	test('with Settings from anywhere on, they open through the tunnel too', async () => {
		const { live, get, post, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		expect(await (await get('/settings', cookie)).text()).toContain('name="_token"');
		await post('/settings', { server: 'machine-1', ownerAnywhere: '1' }, cookie);
		expect(live.ownerAnywhere).toBe(true);
		expect((await get('/settings', cookie, TUNNEL, CLOUDFLARE)).status).toBe(200);
		await post('/settings', { server: 'machine-1' }, cookie, 'http://athena:8800', TUNNEL, CLOUDFLARE);
		expect(live.ownerAnywhere).toBe(false);
		expect((await get('/settings', cookie, TUNNEL, CLOUDFLARE)).status).toBe(403);
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
		expect((await get('/settings', cookie)).headers.get('Content-Security-Policy')).toContain("default-src 'self'");
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

	test("the owner's account is kept on their first visit, and no other account plex.tv says owns the server opens settings", async () => {
		const { live, get, signIn } = athena(ready);
		await get('/', await signIn('owner-token'));
		expect(live.effective.ownerId).toBe('1001');
		const other = athena({ ...ready, ownerId: '9999' });
		const cookie = await other.signIn('owner-token');
		expect((await other.get('/settings', cookie)).headers.get('Location')).toBe('/');
		expect(await (await other.get('/', cookie)).text()).toContain('of 5 Describe Its today');
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
		const { live, get, post, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const bad = await post('/settings', { server: 'machine-1', publicURL: 'http://athena.example.com' }, cookie);
		expect(bad.headers.get('Location')).toBe('/settings?problem=public');
		expect(await (await get('/settings?problem=public', cookie)).text()).toContain('The public address is an https:// address');
		expect(await (await get('/settings?problem=Re-enter+your+key', cookie)).text()).not.toContain('Re-enter');
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

describe('automations', () => {
	const ready = { server: { id: 'machine-1', name: 'Uranus' }, anthropicKey: KEY };

	test('without Audiobookshelf, nothing about automations shows and Describe It is unchanged', async () => {
		const { app, get, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		expect(await (await get('/', cookie)).text()).not.toContain('href="/automations"');
		expect((await get('/automations', cookie)).headers.get('Location')).toBe('/settings#abs');
		const health = await (await app.request('http://athena:8800/healthz')).json();
		expect(health.ready).toBe(true);
	});

	test('the owner connects Audiobookshelf in Settings, then checks chapter names', async () => {
		const { live, runner, get, post, signIn } = athena(ready);
		const cookie = await signIn('owner-token');
		const saved = await post('/settings', { server: 'machine-1', absURL: 'http://abs:13378/', absKey: 'abs-key', audibleRegion: 'uk' }, cookie);
		expect(saved.headers.get('Location')).toBe('/settings?saved');
		expect(live.effective.absURL).toBe('http://abs:13378');
		expect(live.effective.audibleRegion).toBe('uk');
		expect(await (await get('/settings', cookie)).text()).not.toContain('abs-key');

		const page = await (await get('/automations', cookie)).text();
		expect(page).toContain('href="/automations"');
		expect(page).toContain('As jason at http://abs:13378.');
		const run = await post('/automations/chapter-names/run', {}, cookie);
		expect(run.headers.get('Location')).toBe('/automations');
		await runner.idle();
		const id = runner.runs(1)[0]?.id;
		const results = await (await get(`/automations/runs/${id}`, cookie)).text();
		expect(results).toContain('Checked 3 books with an ASIN at ');
		expect(results).toContain('1 can be renamed, 1 can’t (why below)');
		expect(results).toContain('Can be renamed');
		expect(results).toContain('Chapter 1 → Book One: Dune');
		expect(results).toContain('href="http://abs:13378/item/dune"');
		expect(results).toContain('Chapters don’t line up');
		expect(results).toContain('Audible’s chapter 2 starts 3m 20s earlier than this book’s.');
		expect(results).toContain('Nothing was changed.');
		expect(results).toContain('<strong>What you can do:</strong> Press Rename below');
	});

	test('a check started from another site is refused, and Audiobookshelf alone never makes Describe It ready', async () => {
		const { app, post, signIn, runner } = athena({ server: { id: 'machine-1', name: 'Uranus' }, absURL: 'http://abs:13378', absKey: 'abs-key' });
		const cookie = await signIn('owner-token');
		expect((await post('/automations/chapter-names/run', {}, cookie, 'https://evil.example')).status).toBe(403);
		expect(runner.runs()).toHaveLength(0);
		const health = await (await app.request('http://athena:8800/healthz')).json();
		expect(health.ready).toBe(false);
	});

	test('the owner renames what a check found, undoes one, and turns the hourly run on', async () => {
		const withAbs = { ...ready, absURL: 'http://abs:13378', absKey: 'abs-key' };
		const { live, runner, get, post, signIn } = athena(withAbs);
		const cookie = await signIn('owner-token');
		await post('/automations/chapter-names/run', {}, cookie);
		await runner.idle();
		const check = runner.runs(1)[0]?.id;
		expect(await (await get(`/automations/runs/${check}`, cookie)).text()).toContain('Rename this book');

		const renamed = await post(`/automations/runs/${check}/next`, {}, cookie);
		await runner.idle();
		const run = runner.runs(1)[0];
		expect(renamed.headers.get('Location')).toBe(`/automations/runs/${run?.id}`);
		expect(run?.counts).toEqual({ renamed: 1 });
		const page = await (await get(`/automations/runs/${run?.id}`, cookie)).text();
		expect(page).toContain('Renamed');
		expect(page).toContain('>Undo<');

		const undone = await post(`/automations/runs/${run?.id}/undo`, { item: 'dune' }, cookie);
		expect(undone.headers.get('Location')).toBe(`/automations/runs/${run?.id}`);
		expect(await (await get(`/automations/runs/${run?.id}`, cookie)).text()).toContain('Undone');

		await post('/automations/chapter-names/auto', { auto: '1' }, cookie);
		expect(live.autoJobs).toEqual(['chapter-names']);
		expect(await (await get('/automations', cookie)).text()).toContain('On: each hour');
		await post('/automations/chapter-names/auto', {}, cookie);
		expect(live.autoJobs).toEqual([]);
	});

	test("the owner adds an ElevenLabs key, reads one book's audio and approves its titles", async () => {
		const ai: AI = {
			by: 'claude-haiku-5-5',
			pick: async () => {
				throw new Error('not here');
			},
			titles: async () => ({ titles: ['Chapter 1: The Watsons', 'Chapter 2: Mr. Knightley'], usage: { input_tokens: 600, output_tokens: 40 } }),
		};
		const withAbs = { ...ready, absURL: 'http://abs:13378', absKey: 'abs-key' };
		const { live, runner, abs, scribed, get, post, signIn } = athena(withAbs, {}, { ai, cutter: async () => new Uint8Array([1, 2, 3]) });
		(abs.books.emma?.media as Record<string, unknown>).tracks = [{ startOffset: 0, duration: 1000, contentUrl: '/api/items/emma/file/1' }];
		const cookie = await signIn('owner-token');
		await post('/settings', { server: 'machine-1', absURL: 'http://abs:13378', speech: 'elevenlabs', elevenlabsKey: 'eleven-fake-0000' }, cookie);
		expect(live.speech?.name).toBe('ElevenLabs Scribe');
		const settings = await (await get('/settings', cookie)).text();
		expect(settings).not.toContain('eleven-fake-0000');
		expect(settings).toContain('eleven-…0000');

		const page = await (await get('/automations', cookie)).text();
		expect(page).toContain('Titles from the audio');
		expect(page).toContain('<strong>79,496</strong> of 80,339 ElevenLabs credits left');
		expect(page).toContain('(Starter plan). Speech to text has used 206 this period.');
		await post('/automations/audio-titles/run', {}, cookie);
		await runner.idle();
		const check = runner.runs(1)[0]?.id;
		const found = await (await get(`/automations/runs/${check}`, cookie)).text();
		expect(found).toContain('Can be read');
		expect(found).toContain('43s of audio to read, about 0.2¢ with ElevenLabs Scribe');

		const reading = await post(`/automations/runs/${check}/next`, { item: 'emma' }, cookie);
		await runner.idle();
		const read = runner.runs(1)[0]?.id;
		expect(reading.headers.get('Location')).toBe(`/automations/runs/${read}`);
		expect(scribed.map((form) => form.get('model_id'))).toEqual(['scribe_v3', 'scribe_v3', 'scribe_v3']);
		const proposal = await (await get(`/automations/runs/${read}`, cookie)).text();
		expect(proposal).toContain('1 book waits for your approval below');
		expect(proposal).toContain('with ElevenLabs Scribe (12 credits)');
		expect(proposal).toContain('Chapter two. Mr Knightley.');
		expect(proposal).toContain('>Approve<');

		const approved = await post(`/automations/runs/${read}/decide`, { item: 'emma', approve: '1' }, cookie);
		expect(approved.headers.get('Location')).toBe(`/automations/runs/${read}`);
		expect(abs.books.emma?.media.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1: The Watsons', 'Chapter 2: Mr. Knightley']);
		expect(await (await get(`/automations/runs/${read}`, cookie)).text()).toContain('>Undo<');
	});

	test('Test signs in to Audiobookshelf with what was typed, before saving', async () => {
		const { app, signIn, tokenOf } = athena(ready);
		const cookie = await signIn('owner-token');
		const test = async (fields: Record<string, string>) => {
			const body = new FormData();
			body.set('_token', tokenOf(cookie));
			for (const [key, value] of Object.entries(fields)) body.set(key, value);
			const response = await app.request(
				'http://athena:8800/settings/test-abs',
				{ method: 'POST', headers: { Cookie: cookie, Origin: 'http://athena:8800', Host: 'athena:8800' }, body },
				{ surface: 'admin', peer: '127.0.0.1' } satisfies Door,
			);
			return (await response.json()) as { ok: boolean; message: string };
		};
		expect(await test({ absURL: 'http://abs:13378', absKey: 'abs-key' })).toEqual({
			ok: true,
			message: 'Signed in as jason, who can update books. Book libraries: Books (4 books).',
		});
		expect(await test({ absURL: 'http://abs:13378', absKey: 'wrong' })).toEqual({
			ok: false,
			message: 'Audiobookshelf turned the API key down.',
		});
		expect((await test({ absURL: 'abs.local', absKey: 'abs-key' })).ok).toBe(false);
	});

	test("a friend can't open automations or start a job, and a bad address is turned down", async () => {
		const withAbs = { ...ready, absURL: 'http://abs:13378', absKey: 'abs-key' };
		const { live, get, post, signIn, runner } = athena(withAbs);
		const friend = await signIn('friend-token');
		expect((await get('/automations', friend)).headers.get('Location')).toBe('/');
		await post('/automations/chapter-names/run', {}, friend);
		await post('/automations/chapter-names/auto', { auto: '1' }, friend);
		expect(runner.runs()).toHaveLength(0);
		expect(live.autoJobs).toEqual([]);
		const owner = await signIn('owner-token');
		const bad = await post('/settings', { server: 'machine-1', absURL: 'abs.local' }, owner);
		expect(bad.headers.get('Location')).toBe('/settings?problem=abs');
	});
});
