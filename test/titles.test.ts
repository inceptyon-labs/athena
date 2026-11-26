import { describe, expect, test } from 'bun:test';
import { Audiobookshelf } from '../src/abs';
import { chapterClips } from '../src/clips';
import { JOBS, Runner } from '../src/jobs';
import { audioTitles } from '../src/jobs/audio-titles';
import type { AI } from '../src/pick';
import type { Speech } from '../src/speech';
import { cleanTitles, named } from '../src/titles';
import { fakeAbs } from './helpers';

/**
 * Titles from the audio against the fake Audiobookshelf: Emma's chapters are numbered and Audible's don't line up, so
 * it's readable; Dune is named by Audible; Odd has no ASIN, and is served here with one file.
 */
function setup() {
	const base = fakeAbs();
	const track = (id: string) => [{ startOffset: 0, duration: 1000, contentUrl: `/api/items/${id}/file/1` }];
	(base.books.emma?.media as Record<string, unknown>).tracks = track('emma');
	const odd = { id: 'odd', updatedAt: 1, media: { duration: 1000, chapters: [{ id: 0, start: 0, end: 1000, title: '01' }, { id: 1, start: 1000, end: 1000, title: '02' }], tracks: track('odd'), metadata: { title: 'Odd', asin: null } } };
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) =>
		new URL(String(url)).pathname === '/api/items/odd' ? Response.json(odd) : base.fetcher(url, init)) as typeof fetch;
	const abs = new Audiobookshelf('http://abs:13378', 'abs-key', fetcher);
	const cuts: string[][] = [];
	const cutter = async (args: string[]) => {
		cuts.push(args);
		return new Uint8Array([1, 2, 3]);
	};
	const heard: Speech = {
		id: 'elevenlabs',
		name: 'Scribe',
		perHour: 0.2,
		format: 'mp3',
		transcribe: async (clips) => clips.map((clip) => (clip.chapter === 0 ? 'This is Audible. Chapter one. The Watsons.' : 'Chapter two, Mr Knightley.')),
	};
	const asked: string[] = [];
	const ai: AI = {
		by: 'claude-haiku-5-5',
		pick: async () => {
			throw new Error('not here');
		},
		titles: async (req) => {
			asked.push(req.chapters.map((chapter) => chapter.heard).join(' | '));
			return { titles: ['Chapter 1: The Watsons', 'Chapter 2: Mr. Knightley'], usage: { input_tokens: 600, output_tokens: 40 } };
		},
	};
	const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => true, speech: heard, ai, cutter }));
	return { ...base, serve: fetcher, abs, runner, cuts, asked };
}

/** Checks, then reads the books it listed (or just `only`), and resolves to the reading's run. */
async function readAll(runner: Runner, only?: string) {
	const check = runner.start('audio-titles', { dryRun: true }) as number;
	await runner.idle();
	const plan = Object.fromEntries(
		runner
			.items(check)
			.flatMap((item) => (item.outcome === 'readable' && (!only || item.item === only) ? [[item.item, { before: item.before, after: item.after }]] : [])),
	);
	const read = runner.start('audio-titles', { dryRun: false, plan }) as number;
	await runner.idle();
	return { check, read };
}

describe('titles from the audio', () => {
	test('a check lists the numbered books no Audible store names, with what reading would cost, and reads nothing', async () => {
		const { runner, cuts, asked, writes } = setup();
		const id = runner.start('audio-titles', { dryRun: true }) as number;
		await runner.idle();
		const items = runner.items(id);
		expect(items.map((item) => [item.item, item.outcome])).toEqual([
			['dune', 'audible'],
			['emma', 'readable'],
			['odd', 'readable'],
		]);
		expect(items[1]?.detail).toBe('Audible’s chapters don’t line up. 2 chapters: 40s of audio to read, about 0.2¢ with Scribe.');
		expect(items[2]?.detail).toStartWith('It has no ASIN.');
		expect([cuts.length, asked.length, writes()]).toEqual([0, 0, 0]);
	});

	test("a book isn't offered for reading while an Audible store that might name it didn't answer", async () => {
		const base = setup();
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			const target = new URL(String(url));
			if (target.pathname === '/api/search/chapters' && target.searchParams.get('region') === 'ca') throw new Error('down');
			return base.serve(url, init);
		}) as typeof fetch;
		const abs = new Audiobookshelf('http://abs:13378', 'abs-key', fetcher);
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => false }));
		const id = runner.start('audio-titles', { dryRun: true }) as number;
		await runner.idle();
		const emma = runner.items(id).find((item) => item.item === 'emma');
		expect(emma?.outcome).toBe('error');
		expect(emma?.detail).toStartWith("Audible CA didn't answer");
	});

	test("reading cuts each chapter's start and holds the titles for approval, writing nothing", async () => {
		const { runner, cuts, asked, writes } = setup();
		const { read } = await readAll(runner, 'emma');
		const emma = runner.items(read)[0];
		expect(emma?.outcome).toBe('proposed');
		expect(emma?.detail).toStartWith('Chapter 1 → Chapter 1: The Watsons, Chapter 2 → Chapter 2: Mr. Knightley (2 of 2 titles change). Read 40s with Scribe');
		expect(emma?.after).toEqual([
			{ id: 0, start: 0, end: 500, title: 'Chapter 1: The Watsons', heard: 'This is Audible. Chapter one. The Watsons.' },
			{ id: 1, start: 500, end: 1000, title: 'Chapter 2: Mr. Knightley', heard: 'Chapter two, Mr Knightley.' },
		]);
		expect(cuts.map((args) => [args[3], args[5], args[7], args[9]])).toEqual([
			['Authorization: Bearer abs-key\r\n', '0.000', '20.000', 'http://abs:13378/api/items/emma/file/1'],
			['Authorization: Bearer abs-key\r\n', '500.000', '20.000', 'http://abs:13378/api/items/emma/file/1'],
		]);
		expect(asked).toEqual(['This is Audible. Chapter one. The Watsons. | Chapter two, Mr Knightley.']);
		expect(writes()).toBe(0);
	});

	test('approving reads the book again and writes the titles; Undo puts the numbers back; Reject changes nothing', async () => {
		const { runner, books, writes } = setup();
		const { read } = await readAll(runner);
		// Approve pressed twice, then Reject at once: one write, and the later presses find nothing left to decide.
		expect(
			await Promise.all([runner.decide(read, 'emma', true), runner.decide(read, 'emma', true), runner.decide(read, 'emma', false)]),
		).toEqual([null, 'nothing', 'nothing']);
		expect(books.emma?.media.chapters.map((chapter) => [chapter.start, chapter.title])).toEqual([
			[0, 'Chapter 1: The Watsons'],
			[500, 'Chapter 2: Mr. Knightley'],
		]);
		expect(runner.items(read).find((item) => item.item === 'emma')?.outcome).toBe('renamed');
		expect(await runner.decide(read, 'emma', true)).toBe('nothing');

		expect(await runner.undo(read, 'emma')).toBeNull();
		expect(books.emma?.media.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1', 'Chapter 2']);

		expect(await runner.decide(read, 'odd', false)).toBeNull();
		expect(runner.items(read).find((item) => item.item === 'odd')?.outcome).toBe('rejected');
		expect(writes()).toBe(2);
	});

	test('two readings of one book approved at once write it once; the second finds it changed', async () => {
		const { runner, books, writes } = setup();
		const first = (await readAll(runner, 'emma')).read;
		const second = (await readAll(runner, 'emma')).read;
		const answers = await Promise.all([runner.decide(first, 'emma', true), runner.decide(second, 'emma', true)]);
		expect(answers).toEqual([null, 'changed']);
		expect(books.emma?.media.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1: The Watsons', 'Chapter 2: Mr. Knightley']);
		expect(writes()).toBe(1);
	});

	test('a book changed since it was read is left alone when approved', async () => {
		const { runner, books, writes } = setup();
		const { read } = await readAll(runner, 'emma');
		if (books.emma) books.emma.media.chapters[1] = { id: 1, start: 520, end: 1000, title: 'Chapter 2' };
		expect(await runner.decide(read, 'emma', true)).toBe('changed');
		expect(runner.items(read)[0]?.outcome).toBe('changed');
		expect(writes()).toBe(0);
	});

	test("reading fails with what's missing, and the job never runs by itself", async () => {
		const { abs } = fakeAbs();
		const runner = new Runner(':memory:', [audioTitles], () => ({ abs, region: 'us', auto: () => true, cutter: async () => new Uint8Array() }));
		runner.tick();
		expect(runner.runs()).toHaveLength(0);
		const id = runner.start('audio-titles', { dryRun: false, plan: { emma: { before: [], after: [] } } }) as number;
		await runner.idle();
		expect(runner.run(id)?.error).toBe('Choose speech to text in Settings first.');
	});

	test('a chapter is cut from the file it starts in, and carried on into the next when it starts near the end', async () => {
		const { abs } = fakeAbs();
		const cuts: string[][] = [];
		const book = {
			tracks: [
				{ startOffset: 0, duration: 600, contentUrl: '/api/items/x/file/1' },
				{ startOffset: 600, duration: 400, contentUrl: '/api/items/x/file/2' },
			],
		};
		const chapters = [
			{ id: 0, start: 0, end: 590, title: '01' },
			{ id: 1, start: 590, end: 995, title: '02' },
			{ id: 2, start: 995, end: 1000, title: '03' },
		];
		const clips = await chapterClips(abs, book, chapters, {
			format: 'wav',
			cutter: async (args) => {
				cuts.push(args);
				return new Uint8Array([1]);
			},
		});
		const inputs = (args: string[]) => args.flatMap((arg, at) => (arg === '-i' ? [[args[at - 3], args[at - 1], args[at + 1]]] : []));
		expect(cuts.map(inputs)).toEqual([
			[['0.000', '20.000', 'http://abs:13378/api/items/x/file/1']],
			[
				['590.000', '10.000', 'http://abs:13378/api/items/x/file/1'],
				['0.000', '10.000', 'http://abs:13378/api/items/x/file/2'],
			],
			[['395.000', '5.000', 'http://abs:13378/api/items/x/file/2']],
		]);
		expect(cuts[1]).toContain('[0:a][1:a]concat=n=2:v=0:a=1[a]');
		expect(clips.map((clip) => clip.seconds)).toEqual([20, 20, 5]);
	});

	test('titles are one per chapter, and only numbers or credits are no titles', () => {
		expect(cleanTitles(['  Prologue ', '', null], 3)).toEqual(['Prologue', null, null]);
		expect(cleanTitles(['One'], 2)).toBeNull();
		expect(named(['Opening Credits', 'Chapter 1', 'Chapter 2', null], 'Emma')).toBe(false);
		expect(named(['Opening Credits', 'Chapter 1: The Watsons'], 'Emma')).toBe(true);
	});
});
