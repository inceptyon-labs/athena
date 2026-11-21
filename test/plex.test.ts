import { describe, expect, test } from 'bun:test';
import { PlexGate, PlexTV } from '../src/plex';
import { createApp } from '../src/server';
import { fakePlex } from './helpers';

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

const gateFor = (fetcher: typeof fetch, server: { id: string } | { url: string } = { url: 'http://plex:32400' }) =>
	new PlexGate(server, new PlexTV('athena-test', fetcher, 'https://plex.tv'), fetcher);

describe('Plex sign-in', () => {
	test('an account that can reach the server gets picks; others get 401', async () => {
		const plex = fakePlex();
		const app = createApp({ client: {} as never, model: 'test', pick, gate: gateFor(plex.fetcher) });
		expect((await ask(app, 'owner-token')).status).toBe(200);
		expect((await ask(app, 'friend-token')).status).toBe(200);
		expect((await ask(app, 'bad-token')).status).toBe(401);
		expect((await ask(app, 'stranger')).status).toBe(401);
		expect((await ask(app)).status).toBe(401);
	});

	test('the viewer is named, and only the server owner counts as its owner', async () => {
		const gate = gateFor(fakePlex().fetcher);
		expect(await gate.viewer('owner-token')).toEqual({ id: 'owner-id', name: 'Owner', owner: true });
		expect(await gate.viewer('friend-token')).toEqual({ id: 'friend-id', name: 'Friend', owner: false });
	});

	test('a server chosen in settings needs no address', async () => {
		const plex = fakePlex();
		const gate = gateFor(plex.fetcher, { id: 'machine-1' });
		expect(await gate.machineIdentifier()).toBe('machine-1');
		expect((await gate.viewer('friend-token'))?.name).toBe('Friend');
	});

	test('answers are remembered, so Plex is asked once per token', async () => {
		const plex = fakePlex();
		const gate = gateFor(plex.fetcher);
		expect(await gate.viewer('owner-token')).not.toBeNull();
		expect(await gate.viewer('owner-token')).not.toBeNull();
		expect(await gate.viewer('bad-token')).toBeNull();
		expect(await gate.viewer('bad-token')).toBeNull();
		expect(plex.calls()).toBe(2);
	});

	test('a Plex error is a 502, not a refusal', async () => {
		const plex = fakePlex(500);
		const app = createApp({ client: {} as never, model: 'test', pick, gate: gateFor(plex.fetcher) });
		expect((await ask(app, 'other-token')).status).toBe(502);
	});

	test('the health check names the Plex server', async () => {
		const app = createApp({ client: null, model: 'test', gate: gateFor(fakePlex().fetcher) });
		expect((await (await app.request('/healthz')).json()).server).toBe('machine-1');
	});

	test('until a Plex server is chosen, Athena answers no one', async () => {
		const app = createApp({ client: {} as never, model: 'test', pick });
		const response = await ask(app, 'owner-token');
		expect(response.status).toBe(503);
		expect(((await response.json()) as { error: string }).error).toContain('set up');
		expect((await (await app.request('/healthz')).json()).ready).toBe(false);
	});
});
