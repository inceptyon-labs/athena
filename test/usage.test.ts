import { describe, expect, test } from 'bun:test';
import type { PickOutcome } from '../src/pick';
import { cost } from '../src/prices';
import { createApp, type Gate } from '../src/server';
import { type Entry, Usage } from '../src/usage';

const at = (time: string) => new Date(time).getTime();

const entry = (over: Partial<Omit<Entry, 'at'>> = {}): Omit<Entry, 'at'> => ({
	viewerId: 'friend-id',
	viewer: 'Friend',
	kind: 'movie',
	request: 'funny',
	picks: 9,
	suggestions: 0,
	by: 'claude-haiku-5-5',
	ms: 9000,
	status: 200,
	error: null,
	inputTokens: 25_000,
	outputTokens: 400,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0.0027,
	...over,
});

describe('usage', () => {
	test("a Describe It's picks and suggestions count once; a new request or a later one counts again", () => {
		let now = at('2026-11-21T20:00:00');
		const usage = new Usage(':memory:', () => now);
		usage.record(entry({ by: 'jev', suggestions: 0 }));
		usage.record(entry({ picks: 0, suggestions: 6 }));
		expect(usage.usedToday('friend-id')).toBe(1);
		usage.record(entry({ request: 'scary' }));
		expect(usage.usedToday('friend-id')).toBe(2);
		now += 3 * 60_000;
		usage.record(entry());
		expect(usage.usedToday('friend-id')).toBe(3);
		expect(usage.usedToday('owner-id')).toBe(0);
	});

	test('a failed or refused request counts for nothing', () => {
		const usage = new Usage(':memory:', () => at('2026-11-21T20:00:00'));
		usage.record(entry({ status: 502, by: '', error: 'Claude is busy. Try again.', cost: 0 }));
		usage.record(entry({ status: 429, by: '', cost: 0 }));
		expect(usage.usedToday('friend-id')).toBe(0);
		expect(usage.recent().map((row) => row.status)).toEqual([429, 502]);
	});

	test('today starts at midnight and the month on the first, in the server time zone', () => {
		let now = at('2026-11-30T23:00:00');
		const usage = new Usage(':memory:', () => now);
		usage.record(entry({ cost: 0.5 }));
		now = at('2026-12-01T09:00:00');
		usage.record(entry({ request: 'scary', cost: 0.25 }));
		usage.record(entry({ request: 'sad', by: 'claude-mystery-9', cost: null }));
		expect(usage.usedToday('friend-id')).toBe(2);
		expect(usage.totals()).toEqual({ today: 2, month: 2, spendToday: 0.25, spendMonth: 0.25, unpriced: true });
	});

	test("today's Describe Its per person, under their latest name, most first", () => {
		let now = at('2026-11-20T21:00:00');
		const usage = new Usage(':memory:', () => now);
		usage.record(entry({ viewerId: 'owner-id', viewer: 'Owner' }));
		now = at('2026-11-21T09:00:00');
		usage.record(entry({ viewerId: 'owner-id', viewer: 'Owner' }));
		usage.record(entry({ request: 'one' }));
		usage.record(entry({ request: 'one', suggestions: 6 }));
		usage.record(entry({ request: 'two', viewer: 'Friend Renamed' }));
		usage.record(entry({ viewerId: 'kid-id', viewer: 'Kid', status: 502, by: '', cost: 0 }));
		expect(usage.todayByPerson()).toEqual([
			{ viewerId: 'friend-id', viewer: 'Friend Renamed', count: 2 },
			{ viewerId: 'owner-id', viewer: 'Owner', count: 1 },
			{ viewerId: 'kid-id', viewer: 'Kid', count: 0 },
		]);
	});

	test("the prompt size for estimates is the last 30 days' AI answers, once there are a few", () => {
		let now = at('2026-11-21T20:00:00');
		const usage = new Usage(':memory:', () => now);
		usage.record(entry({ inputTokens: 1000, cacheRead: 24_000 }));
		usage.record(entry({ by: 'jev', inputTokens: 90_000 }));
		usage.record(entry({ status: 502, by: '', inputTokens: 0 }));
		expect(usage.promptSize()).toBeNull();
		usage.record(entry({ request: 'two', inputTokens: 29_000, cacheRead: 0 }));
		usage.record(entry({ request: 'three', inputTokens: 30_000, cacheRead: 0 }));
		expect(usage.promptSize()).toBe(28_000);
		now += 31 * 86_400_000;
		expect(usage.promptSize()).toBeNull();
	});

	test('the recent list is newest first, up to the number asked', () => {
		let now = at('2026-11-21T08:00:00');
		const usage = new Usage(':memory:', () => now);
		for (const request of ['one', 'two', 'three']) {
			usage.record(entry({ request }));
			now += 1000;
		}
		expect(usage.recent(2).map((row) => row.request)).toEqual(['three', 'two']);
	});
});

test('spend comes from the token counts at each model’s price', () => {
	expect(cost('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 0 })).toBeCloseTo(0.005, 6);
	expect(
		cost('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 0 }),
	).toBeCloseTo((1000 * 0.1 + 1000 * 0.5 + 24_000 * 0.01) / 1e6);
	expect(cost('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 0 })).toBeCloseTo(0.1);
	expect(cost('jev', { input_tokens: 1_000_000, output_tokens: 5000 })).toBeCloseTo(0.042);
	expect(cost('claude-mystery-9', { input_tokens: 1, output_tokens: 1 })).toBeNull();
});

describe('daily limit', () => {
	const gate: Gate = {
		machineIdentifier: async () => 'machine-1',
		viewer: async (token) =>
			token === 'owner-token' ? { id: 'owner-id', name: 'Owner', owner: true } : { id: 'friend-id', name: 'Friend', owner: false },
	};
	const outcome: PickOutcome = {
		picks: [{ id: '1', reason: 'Gags.' }],
		suggestions: [],
		minimums: { critics: null, audience: null, imdb: null },
		usage: { input_tokens: 25_000, output_tokens: 400 },
	};
	const setup = () => {
		const usage = new Usage(':memory:');
		const app = createApp({
			ai: { by: 'claude-haiku-5-5', pick: async () => outcome },
			provider: 'anthropic',
			model: 'claude-haiku-5-5',
			gate,
			usage,
			dailyLimit: 2,
			ownerName: 'Jason',
		});
		const ask = (token: string, request: string) =>
			app.request('/v1/pick', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Plex-Token': token },
				body: JSON.stringify({ request, kind: 'movie', titles: [{ id: '1', title: 'Airplane!' }] }),
			});
		return { usage, ask };
	};

	test('past the limit a friend gets a 429 Ithaca can show, and it is logged', async () => {
		const { usage, ask } = setup();
		expect((await ask('friend-token', 'funny')).status).toBe(200);
		expect((await ask('friend-token', 'scary')).status).toBe(200);
		const refused = await ask('friend-token', 'sad');
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({
			error: "You've used Describe It 2 times today on Jason's Athena. It resets at midnight.",
		});
		expect(usage.recent(1)[0]).toMatchObject({ status: 429, viewer: 'Friend', request: 'sad' });
		expect(usage.recent(2)[1]).toMatchObject({ status: 200, by: 'claude-haiku-5-5', inputTokens: 25_000 });
	});

	test('the second half of a Describe It already counted still gets through', async () => {
		const { ask } = setup();
		await ask('friend-token', 'funny');
		await ask('friend-token', 'scary');
		expect((await ask('friend-token', 'scary')).status).toBe(200);
	});

	test('a bad body or a failed answer uses none of the limit', async () => {
		const usage = new Usage(':memory:');
		let fail = true;
		const app = createApp({
			ai: {
				by: 'claude-haiku-5-5',
				pick: async () => {
					if (fail) throw new Error('Claude is busy. Try again.');
					return outcome;
				},
			},
			provider: 'anthropic',
			model: 'claude-haiku-5-5',
			gate,
			usage,
			dailyLimit: 1,
		});
		const ask = (body: string) =>
			app.request('/v1/pick', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Plex-Token': 'friend-token' },
				body,
			});
		const good = JSON.stringify({ request: 'funny', kind: 'movie', titles: [{ id: '1', title: 'Airplane!' }] });
		expect((await ask('{"request": ""}')).status).toBe(400);
		expect((await ask(good)).status).toBe(502);
		fail = false;
		expect((await ask(good)).status).toBe(200);
		expect((await ask(good.replace('funny', 'scary'))).status).toBe(429);
	});

	test('the owner has no limit', async () => {
		const { ask } = setup();
		for (const request of ['one', 'two', 'three', 'four']) expect((await ask('owner-token', request)).status).toBe(200);
	});
});
