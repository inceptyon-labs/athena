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
		const app = createApp({ ai: { by: 'test', pick }, provider: 'anthropic', model: 'test', gate: gateFor(plex.fetcher) });
		expect((await ask(app, 'owner-token')).status).toBe(200);
		expect((await ask(app, 'friend-token')).status).toBe(200);
		expect((await ask(app, 'bad-token')).status).toBe(401);
		expect((await ask(app, 'stranger')).status).toBe(401);
		expect((await ask(app)).status).toBe(401);
	});

	test('the viewer is named, and only the server owner counts as its owner', async () => {
		const gate = gateFor(fakePlex().fetcher);
		expect(await gate.viewer('owner-token')).toEqual({ id: '1001', name: 'Owner', owner: true });
		expect(await gate.viewer('friend-token')).toEqual({ id: '1002', name: 'friend', owner: false });
	});

	test('once the owner who set Athena up is known, another account plex.tv says owns the server is only a viewer', async () => {
		const plex = fakePlex();
		const gate = new PlexGate({ id: 'machine-1' }, new PlexTV('athena-test', plex.fetcher), plex.fetcher, Date.now, () => '9999');
		expect(await gate.viewer('owner-token')).toEqual({ id: '1001', name: 'Owner', owner: false });
	});

	test('a server chosen in settings needs no address', async () => {
		const plex = fakePlex();
		const gate = gateFor(plex.fetcher, { id: 'machine-1' });
		expect(await gate.machineIdentifier()).toBe('machine-1');
		expect((await gate.viewer('friend-token'))?.name).toBe('friend');
	});

	test('access and the account are remembered together, so plex.tv is asked once per token', async () => {
		let now = 0;
		const plex = fakePlex();
		const gate = new PlexGate({ id: 'machine-1' }, new PlexTV('athena-test', plex.fetcher), plex.fetcher, () => now);
		expect(await gate.viewer('owner-token')).not.toBeNull();
		expect(await gate.viewer('owner-token')).not.toBeNull();
		expect(await gate.viewer('bad-token')).toBeNull();
		expect(await gate.viewer('bad-token')).toBeNull();
		expect([plex.calls(), plex.accounts()]).toEqual([2, 2]);
		now += 11 * 60_000;
		expect((await gate.viewer('owner-token'))?.name).toBe('Owner');
		expect([plex.calls(), plex.accounts()]).toEqual([3, 3]);
	});

	test('an account is its plex.tv id and title, or its username without one', async () => {
		const plexTV = new PlexTV('athena-test', fakePlex().fetcher);
		expect(await plexTV.account('owner-token')).toMatchObject({ id: '1001', name: 'Owner' });
		expect(await plexTV.account('friend-token')).toMatchObject({ id: '1002', name: 'friend' });
		expect(await plexTV.account('bad-token')).toBeNull();
	});

	test("with the owner's token, a friend's or Home member's token for the server is enough, and the share list is read once a minute", async () => {
		let now = 0;
		const plex = fakePlex();
		let ownerToken: string | null = 'owner-token';
		const gate = new PlexGate(
			{ id: 'machine-1' },
			new PlexTV('athena-test', plex.fetcher),
			plex.fetcher,
			() => now,
			() => '1001',
			() => ownerToken,
		);
		expect(gate.acceptsServerTokens()).toBe(true);
		expect(await gate.viewer('friend-share')).toEqual({ id: '1002', name: 'friend', owner: false });
		expect(await gate.viewer('kid-share')).toEqual({ id: '1004', name: 'Kid & Co', owner: false });
		// The owner's own device tokens are account tokens, checked as before; so is an older Ithaca's account token.
		expect(await gate.viewer('owner-token')).toEqual({ id: '1001', name: 'Owner', owner: true });
		expect(await gate.viewer('friend-token')).toEqual({ id: '1002', name: 'friend', owner: false });
		expect(await gate.viewer('owner-device')).toBeNull();
		expect(plex.shares()).toBe(1);
		now += 61_000;
		expect(await gate.viewer('someone-else')).toBeNull();
		expect(plex.shares()).toBe(2);
		ownerToken = null;
		expect(gate.acceptsServerTokens()).toBe(false);
	});

	test("without the owner's token, or once plex.tv refuses it, a token for the server alone gets nowhere", async () => {
		const plex = fakePlex();
		const without = new PlexGate({ id: 'machine-1' }, new PlexTV('athena-test', plex.fetcher), plex.fetcher);
		expect(without.acceptsServerTokens()).toBe(false);
		expect(await without.viewer('friend-share')).toBeNull();
		expect(plex.shares()).toBe(0);

		const refused = new PlexGate(
			{ id: 'machine-1' },
			new PlexTV('athena-test', plex.fetcher),
			plex.fetcher,
			Date.now,
			() => null,
			() => 'revoked-owner-token',
		);
		expect(await refused.viewer('friend-share')).toBeNull();
		expect(refused.acceptsServerTokens()).toBe(false);
		expect(await refused.viewer('kid-share')).toBeNull();
		expect(plex.shares()).toBe(1);
	});

	test('a Plex error is a 502, not a refusal', async () => {
		const plex = fakePlex(500);
		const app = createApp({ ai: { by: 'test', pick }, provider: 'anthropic', model: 'test', gate: gateFor(plex.fetcher) });
		expect((await ask(app, 'other-token')).status).toBe(502);
	});

	test("the health check names the Plex server, and says whether a token for it is enough", async () => {
		const app = createApp({ ai: null, provider: 'anthropic', model: 'test', gate: gateFor(fakePlex().fetcher) });
		const health = await (await app.request('/healthz')).json();
		expect(health.server).toBe('machine-1');
		expect(health.serverTokens).toBe(false);
		const plex = fakePlex();
		const withOwner = new PlexGate({ id: 'machine-1' }, new PlexTV('athena-test', plex.fetcher), plex.fetcher, Date.now, () => null, () => 'owner-token');
		const ready = createApp({ ai: null, provider: 'anthropic', model: 'test', gate: withOwner });
		expect((await (await ready.request('/healthz')).json()).serverTokens).toBe(true);
	});

	test('until a Plex server is chosen, Athena answers no one', async () => {
		const app = createApp({ ai: { by: 'test', pick }, provider: 'anthropic', model: 'test' });
		const response = await ask(app, 'owner-token');
		expect(response.status).toBe(503);
		expect(((await response.json()) as { error: string }).error).toContain('set up');
		expect((await (await app.request('/healthz')).json()).ready).toBe(false);
	});
});
