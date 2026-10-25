import { describe, expect, test } from 'bun:test';
import { cleanPicks, libraryText, PickRequest, requestText } from '../src/pick';
import { createApp } from '../src/server';

const request = PickRequest.parse({
	request: 'something funny under two hours',
	kind: 'movie',
	count: 2,
	titles: [
		{ id: '1', title: 'Heat', year: 1995, genres: ['Crime', 'Thriller'], minutes: 170, contentRating: 'R', seen: true, rating: 'loved' },
		{ id: '2', title: 'Airplane!', year: 1980, genres: ['Comedy'], minutes: 88 },
		{ id: '3', title: 'Hot Fuzz', year: 2007 },
	],
	taste: { loved: ['Heat (1995)'], disliked: ['Cats (2019)'] },
	exclude: ['3'],
});

describe('prompt', () => {
	test('one line per title, then the taste that is known', () => {
		const text = libraryText(request);
		expect(text).toContain('1 | Heat (1995) | Crime, Thriller | 170 min | R | seen, loved');
		expect(text).toContain('2 | Airplane! (1980) | Comedy | 88 min |  | ');
		expect(text).toContain('Loved: Heat (1995)\nDid not like: Cats (2019)');
		expect(text).not.toContain('Watched lately');
	});

	test('the request carries what was already suggested', () => {
		expect(requestText(request)).toBe(
			'Request: "something funny under two hours"\nAlready suggested, leave these ids out: 3\nPick up to 2.',
		);
	});
});

test('picks keep only listed, new ids, each once, up to the count', () => {
	const picks = cleanPicks(
		[
			{ id: '9', reason: 'not on the list' },
			{ id: '3', reason: 'already suggested' },
			{ id: ' 2 ', reason: ' Broad gags. ' },
			{ id: '2', reason: 'twice' },
			{ id: '1', reason: 'Tense.' },
			{ id: '1', reason: 'over the count' },
		],
		request,
	);
	expect(picks).toEqual([
		{ id: '2', reason: 'Broad gags.' },
		{ id: '1', reason: 'Tense.' },
	]);
});

describe('POST /v1/pick', () => {
	const body = JSON.stringify({ request: 'funny', kind: 'movie', titles: [{ id: '1', title: 'Airplane!' }] });
	const post = (app: ReturnType<typeof createApp>, payload: string) =>
		app.request('/v1/pick', { method: 'POST', body: payload, headers: { 'content-type': 'application/json' } });

	test('answers with the picks', async () => {
		const app = createApp({
			client: {} as never,
			model: 'test',
			pick: async () => ({
				picks: [{ id: '1', reason: 'Gags.' }],
				usage: { input_tokens: 1, output_tokens: 1 } as never,
			}),
		});
		const response = await post(app, body);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ picks: [{ id: '1', reason: 'Gags.' }] });
	});

	test('a bad body is a 400, a missing key a 503', async () => {
		const app = createApp({ client: {} as never, model: 'test' });
		expect((await post(app, '{"request":""}')).status).toBe(400);
		expect((await post(createApp({ client: null, model: 'test' }), body)).status).toBe(503);
	});
});
