import { describe, expect, test } from 'bun:test';
import type { AbsChapter, AudibleChapters } from '../src/abs';
import { isNumbered, match } from '../src/chapters';

const marks = (...starts: number[]): AbsChapter[] =>
	starts.map((start, index) => ({ id: index, start, end: starts[index + 1] ?? 1003, title: `Chapter ${index + 1}` }));

/** Audible's chapters for a 1,003-second book with a 2-second intro and 3-second outro. */
const audible: AudibleChapters = {
	chapters: [
		{ startOffsetMs: 0, lengthMs: 2000, title: 'Opening Credits' },
		{ startOffsetMs: 2000, lengthMs: 598_000, title: 'Prologue' },
		{ startOffsetMs: 600_000, lengthMs: 400_000, title: 'The Boy Who Lived' },
		{ startOffsetMs: 1_000_000, lengthMs: 3000, title: 'End Credits' },
	],
	runtimeLengthMs: 1_003_000,
	brandIntroDurationMs: 2000,
	brandOutroDurationMs: 3000,
};

describe('numbered chapter titles', () => {
	test('a title that is only a number counts, with or without the book title', () => {
		for (const title of ['Chapter 1', 'Chapter 01', '01', 'Track 3', 'Dune - 07', '007 - Dune', 'Ch. 12', 'Part 2', '1 of 12', 'Dune'])
			expect(isNumbered(title, 'Dune')).toBe(true);
	});

	test('a title with words in it is a name', () => {
		for (const title of ['Chapter One', 'Prologue', 'The Boy Who Lived', 'Chapter 1: The Boy Who Lived'])
			expect(isNumbered(title, 'Dune')).toBe(false);
	});
});

describe("matching Audible's names to a book's chapters", () => {
	test('the same edition gets the names and keeps its own chapter marks', () => {
		const book = marks(0, 2, 600.5, 1000);
		const outcome = match(audible, book, 1003, 'X');
		expect(outcome.kind).toBe('ready');
		if (outcome.kind !== 'ready') return;
		expect(outcome.chapters.map((chapter) => chapter.title)).toEqual(['Opening Credits', 'Prologue', 'The Boy Who Lived', 'End Credits']);
		expect(outcome.chapters.map((chapter) => chapter.start)).toEqual([0, 2, 600.5, 1000]);
	});

	test("a file cut without Audible's intro and outro still matches, without the opening credits", () => {
		const outcome = match(audible, [{ id: 0, start: 0, end: 598, title: '1' }, { id: 1, start: 598, end: 997.5, title: '2' }], 997.5, 'X');
		expect(outcome.kind === 'ready' && outcome.chapters.map((chapter) => chapter.title)).toEqual(['Prologue', 'The Boy Who Lived']);
	});

	test('the same length with chapters in other places is left alone', () => {
		expect(match(audible, marks(0, 500), 1003, 'X').kind).toBe('marksDiffer');
	});

	test('a chapter shorter than the tolerance is kept', () => {
		const short: AudibleChapters = {
			chapters: [
				{ startOffsetMs: 0, lengthMs: 1000, title: 'Epigraph' },
				{ startOffsetMs: 1000, lengthMs: 99_000, title: 'Prologue' },
				{ startOffsetMs: 100_000, lengthMs: 100_000, title: 'One' },
			],
			runtimeLengthMs: 200_000,
		};
		const book = [
			{ id: 0, start: 0, end: 1, title: '1' },
			{ id: 1, start: 1, end: 100, title: '2' },
			{ id: 2, start: 100, end: 200, title: '3' },
		];
		expect(match(short, book, 200, 'X').kind).toBe('ready');
	});

	test('another edition, numbered names and no chapters each say why', () => {
		expect(match(audible, marks(0, 450), 900, 'X')).toEqual({ kind: 'lengthDiffers', seconds: 103 });
		const numbered = { ...audible, chapters: audible.chapters?.map((chapter, index) => ({ ...chapter, title: `Chapter ${index}` })) };
		expect(match(numbered, marks(0, 2, 600, 1000), 1003, 'X').kind).toBe('noNames');
		expect(match({ error: 'Chapters not found' }, marks(0, 500), 1003, 'X').kind).toBe('notFound');
	});
});
