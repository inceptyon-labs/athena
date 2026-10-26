import { describe, expect, test } from 'bun:test';
import {
	cleanMinimums,
	cleanPicks,
	cleanSuggestions,
	discoverText,
	libraryText,
	PickRequest,
	requestText,
} from '../src/pick';
import { createApp } from '../src/server';

const request = PickRequest.parse({
	request: 'something funny under two hours',
	kind: 'movie',
	count: 2,
	titles: [
		{
			id: '1',
			title: 'Heat',
			year: 1995,
			genres: ['Crime', 'Thriller'],
			minutes: 170,
			contentRating: 'R',
			scores: { critics: 88, audience: 94 },
			seen: true,
			rating: 'loved',
		},
		{ id: '2', title: 'Airplane!', year: 1980, genres: ['Comedy'], minutes: 88, scores: { imdb: 7.7 } },
		{ id: '3', title: 'Hot Fuzz', year: 2007 },
	],
	taste: { loved: ['Heat (1995)'], disliked: ['Cats (2019)'] },
	exclude: ['3'],
	suggest: 2,
	discover: [{ id: 'd1', title: 'The Cycle', year: 2026, genres: ['Horror'], tmdb: 7.4, overview: 'A daughter digs.' }],
	maxMinutes: 120,
});

describe('prompt', () => {
	test('one line per title with its scores, then the taste that is known', () => {
		const text = libraryText(request);
		expect(text).toContain('1 | Heat (1995) | Crime, Thriller | 170 min | R | RT critics 88%, RT audience 94% | seen, loved');
		expect(text).toContain('2 | Airplane! (1980) | Comedy | 88 min |  | IMDb 7.7 | ');
		expect(text).toContain('Loved: Heat (1995)\nDid not like: Cats (2019)');
		expect(text).not.toContain('Watched lately');
	});

	test('the recent list only goes out when suggestions are wanted', () => {
		expect(discoverText(request)).toContain('d1 | The Cycle (2026) | Horror | TMDB 7.4 | A daughter digs.');
		expect(discoverText({ ...request, suggest: 0 })).toBeNull();
	});

	test('the request carries the filters and what was already suggested', () => {
		expect(requestText(request)).toBe(
			'Request: "something funny under two hours"\nFilters set on screen: under 120 minutes.\n' +
				'Already suggested, leave these ids out: 3\nPick up to 2.\nSuggest 2 movies the household does not have, fewer only when fewer fit.',
		);
	});

	test('no picks to make is allowed only with suggestions wanted', () => {
		const body = { request: 'space', kind: 'movie', titles: [] };
		expect(PickRequest.safeParse(body).success).toBe(false);
		expect(PickRequest.safeParse({ ...body, suggest: 3 }).success).toBe(true);
		const suggestionsOnly = PickRequest.parse({ ...body, titles: [{ id: '1', title: 'Moon' }], count: 0, suggest: 3 });
		expect(requestText(suggestionsOnly)).toEndWith('Pick none.\nSuggest 3 movies the household does not have, fewer only when fewer fit.');
		expect(PickRequest.safeParse({ ...suggestionsOnly, suggest: 0 }).success).toBe(false);
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

test('suggestions are each title once, up to the number asked, with only listed discover ids', () => {
	const suggestions = cleanSuggestions(
		[
			{ title: ' Sunshine ', year: 2007, discoverId: 'd9', reason: ' Bleak. ' },
			{ title: 'sunshine', year: 2007, discoverId: null, reason: 'twice' },
			{ title: 'The Cycle', year: 2026, discoverId: 'd1', reason: 'New.' },
			{ title: 'Moon', year: 2009, discoverId: null, reason: 'over the number' },
		],
		request,
	);
	expect(suggestions).toEqual([
		{ title: 'Sunshine', year: 2007, discoverId: null, reason: 'Bleak.' },
		{ title: 'The Cycle', year: 2026, discoverId: 'd1', reason: 'New.' },
	]);
});

test('minimums are percent for Rotten Tomatoes and out of 10 for IMDb, whatever scale came back', () => {
	expect(cleanMinimums({ critics: 8, audience: 85, imdb: 75 })).toEqual({ critics: 80, audience: 85, imdb: 7.5 });
	expect(cleanMinimums({ critics: null, audience: 0, imdb: null })).toEqual({ critics: null, audience: null, imdb: null });
});

describe('POST /v1/pick', () => {
	const body = JSON.stringify({ request: 'funny', kind: 'movie', titles: [{ id: '1', title: 'Airplane!' }] });
	const post = (app: ReturnType<typeof createApp>, payload: string) =>
		app.request('/v1/pick', { method: 'POST', body: payload, headers: { 'content-type': 'application/json' } });

	test('answers with the picks, suggestions and minimums', async () => {
		const minimums = { critics: 80, audience: null, imdb: null };
		const app = createApp({
			client: {} as never,
			model: 'test',
			pick: async () => ({
				picks: [{ id: '1', reason: 'Gags.' }],
				suggestions: [],
				minimums,
				usage: { input_tokens: 1, output_tokens: 1 } as never,
			}),
		});
		const response = await post(app, body);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ picks: [{ id: '1', reason: 'Gags.' }], suggestions: [], minimums });
	});

	test('a bad body is a 400, a missing key a 503', async () => {
		const app = createApp({ client: {} as never, model: 'test' });
		expect((await post(app, '{"request":""}')).status).toBe(400);
		expect((await post(createApp({ client: null, model: 'test' }), body)).status).toBe(503);
	});
});
