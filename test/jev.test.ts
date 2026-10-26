import { expect, test } from 'bun:test';
import { jevQuestions, jevTitleLine, rankPicks, readMinimums } from '../src/jev';
import { PickRequest, type PickOutcome } from '../src/pick';
import { createApp } from '../src/server';

const request = PickRequest.parse({
	request: 'a sci fi space thriller',
	kind: 'movie',
	count: 2,
	titles: [
		{ id: 'a', title: 'Sunshine', year: 2007, genres: ['Science Fiction', 'Thriller'], minutes: 107, contentRating: 'R', scores: { critics: 77, audience: 73 } },
		{ id: 'b', title: 'Moon', year: 2009, scores: { critics: 90 } },
		{ id: 'c', title: 'Serenity', year: 2005 },
		{ id: 'd', title: 'Airplane!', year: 1980, scores: { critics: 97 } },
	],
	exclude: ['c'],
});

test('each title is one line of what Ithaca knows about it', () => {
	expect(jevTitleLine(request.titles[0]!)).toBe(
		'Sunshine (2007) | Science Fiction, Thriller | 107 min | R | RT critics 77%, RT audience 73%',
	);
	expect(jevTitleLine(request.titles[2]!)).toBe('Serenity (2005)');
});

test('titles go in batches keyed by their place, and the first batch also reads the minimums', () => {
	const many = { ...request, titles: Array.from({ length: 501 }, (_, i) => ({ id: String(i), title: `T${i}` })) };
	const first = Object.keys(jevQuestions(many, 0));
	expect(first.slice(0, 3)).toEqual(['minCritics', 'minAudience', 'minImdb']);
	expect(first).toHaveLength(503);
	expect(Object.keys(jevQuestions(many, 500))).toEqual(['t500']);
});

test('picks are the likeliest fits up to the count, never excluded, unlikely or below a minimum', () => {
	const none = { critics: null, audience: null, imdb: null };
	// Serenity is excluded, Airplane! too unlikely.
	expect(rankPicks(request, [0.6, 0.9, 0.95, 0.2], none)).toEqual([
		{ id: 'b', reason: '' },
		{ id: 'a', reason: '' },
	]);
	// Sunshine is listed below 80; Serenity has no score but is excluded.
	expect(rankPicks({ ...request, exclude: [] }, [0.6, 0.9, 0.5, 0.2], { ...none, critics: 80 }).map((p) => p.id)).toEqual([
		'b',
		'c',
	]);
});

test('minimums read "none" as unset', () => {
	expect(readMinimums({ minCritics: { choice: '80' }, minAudience: { choice: 'none' }, minImdb: { choice: '7.5' } })).toEqual({
		critics: 80,
		audience: null,
		imdb: 7.5,
	});
	expect(readMinimums({})).toEqual({ critics: null, audience: null, imdb: null });
});

test('with a TypeSafe key, picks go to Jev and suggestions to Claude, which also takes over when Jev fails', async () => {
	const outcome = (reason: string): PickOutcome => ({
		picks: [{ id: '1', reason }],
		suggestions: [],
		minimums: { critics: null, audience: null, imdb: null },
		usage: { input_tokens: 1, output_tokens: 1 },
	});
	let jevFails = false;
	const app = createApp({
		client: {} as never,
		model: 'test',
		jevKey: 'key',
		pick: async () => outcome('claude'),
		pickWithJev: async () => {
			if (jevFails) throw new Error('down');
			return outcome('');
		},
	});
	const post = async (body: object) => {
		const response = await app.request('/v1/pick', {
			method: 'POST',
			body: JSON.stringify({ request: 'funny', kind: 'movie', titles: [{ id: '1', title: 'Airplane!' }], ...body }),
			headers: { 'content-type': 'application/json' },
		});
		return ((await response.json()) as { picks: { reason: string }[] }).picks[0]?.reason;
	};
	expect(await post({})).toBe('');
	expect(await post({ count: 0, suggest: 3 })).toBe('claude');
	jevFails = true;
	expect(await post({})).toBe('claude');
});
