import { describe, expect, test } from 'bun:test';
import { PlexGate } from '../src/plex';
import { createApp } from '../src/server';

/** A Plex server and plex.tv that know one account, which can reach the server. */
function fakePlex(good = 'good-token', status = 401) {
	let calls = 0;
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		if (path === '/identity') return Response.json({ MediaContainer: { machineIdentifier: 'machine-1' } });
		calls += 1;
		const token = new Headers(init?.headers).get('X-Plex-Token');
		if (token === good) return Response.json([{ clientIdentifier: 'other-server' }, { clientIdentifier: 'machine-1' }]);
		if (token === 'stranger') return Response.json([{ clientIdentifier: 'other-server' }]);
		return new Response('', { status });
	}) as typeof fetch;
	return { fetcher, calls: () => calls };
}

const pick = async () => ({
	picks: [{ id: '1', reason: '' }],
	suggestions: [],
	minimums: { critics: null, audience: null, imdb: null },
	usage: { input_tokens: 1, output_tokens: 1 } as never,
});

const body = JSON.stringify({ request: 'funny', kind: 'movie', count: 1, titles: [{ id: '1', title: 'Airplane!' }], taste: {}, exclude: [] });

function ask(app: ReturnType<typeof createApp>, token?: string) {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (token) headers['X-Plex-Token'] = token;
	return app.request('/v1/pick', { method: 'POST', headers, body });
}

describe('Plex sign-in', () => {
	test('an account that can reach the server gets picks; others get 401', async () => {
		const plex = fakePlex();
		const app = createApp({ client: {} as never, model: 'test', pick, gate: new PlexGate('http://plex:32400', plex.fetcher) });
		expect((await ask(app, 'good-token')).status).toBe(200);
		expect((await ask(app, 'bad-token')).status).toBe(401);
		expect((await ask(app, 'stranger')).status).toBe(401);
		expect((await ask(app)).status).toBe(401);
	});

	test('answers are remembered, so Plex is asked once per token', async () => {
		const plex = fakePlex();
		const gate = new PlexGate('http://plex:32400', plex.fetcher);
		expect(await gate.allows('good-token')).toBe(true);
		expect(await gate.allows('good-token')).toBe(true);
		expect(await gate.allows('bad-token')).toBe(false);
		expect(await gate.allows('bad-token')).toBe(false);
		expect(plex.calls()).toBe(2);
	});

	test('a Plex error is a 502, not a refusal', async () => {
		const plex = fakePlex('good-token', 500);
		const app = createApp({ client: {} as never, model: 'test', pick, gate: new PlexGate('http://plex:32400', plex.fetcher) });
		expect((await ask(app, 'other-token')).status).toBe(502);
	});

	test('the health check names the Plex server', async () => {
		const plex = fakePlex();
		const app = createApp({ client: null, model: 'test', gate: new PlexGate('http://plex:32400', plex.fetcher) });
		expect((await (await app.request('/healthz')).json()).server).toBe('machine-1');
	});

	test('without PLEX_URL anyone may ask', async () => {
		const app = createApp({ client: {} as never, model: 'test', pick });
		expect((await ask(app)).status).toBe(200);
	});
});
