import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Audiobookshelf } from '../src/abs';
import { EVERY, JOBS, Runner } from '../src/jobs';
import { fakeAbs } from './helpers';

describe('the job runner', () => {
	test("a check logs the numbered books with Audible's answer, and writes nothing", async () => {
		const { abs, writes } = fakeAbs();
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => false }));
		const id = runner.start('chapter-names', { dryRun: true });
		expect(typeof id).toBe('number');
		await runner.idle();
		const run = runner.run(id as number);
		expect(run?.status).toBe('done');
		expect(run?.total).toBe(3);
		expect(run?.counts).toEqual({ ready: 1, marksDiffer: 1 });
		const items = runner.items(id as number);
		expect(items.map((item) => [item.item, item.outcome])).toEqual([
			['dune', 'ready'],
			['emma', 'marksDiffer'],
		]);
		expect(items[0]?.detail).toContain('Book One: Dune');
		expect(items[0]?.before).toEqual(['Chapter 1', 'Chapter 2']);
		expect(writes()).toBe(0);
	});

	test('one run at a time, and none without Audiobookshelf', async () => {
		const { abs } = fakeAbs();
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => false }));
		runner.start('chapter-names', { dryRun: true });
		expect(runner.start('chapter-names', { dryRun: true })).toBe('busy');
		await runner.idle();
		expect(runner.start('nothing', { dryRun: true })).toBe('unknown');
		expect(new Runner(':memory:', JOBS, () => ({ abs: null, region: 'us', auto: () => false })).start('chapter-names', { dryRun: true })).toBe(
			'unconnected',
		);
	});

	test('a rejected API key fails the run with why', async () => {
		const wrong = new Audiobookshelf('http://abs:13378', 'wrong', fakeAbs().fetcher);
		const runner = new Runner(':memory:', JOBS, () => ({ abs: wrong, region: 'us', auto: () => false }));
		const id = runner.start('chapter-names', { dryRun: true }) as number;
		await runner.idle();
		expect(runner.run(id)?.status).toBe('failed');
		expect(runner.run(id)?.error).toBe('Audiobookshelf turned the API key down.');
	});

	test('a run still going when Athena stopped is marked stopped', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'athena-jobs-')), 'jobs.db');
		const { abs } = fakeAbs();
		const first = new Runner(path, JOBS, () => ({ abs, region: 'us', auto: () => false }));
		const id = first.start('chapter-names', { dryRun: true }) as number;
		const after = new Runner(path, JOBS, () => ({ abs, region: 'us', auto: () => false }));
		expect(after.run(id)?.status).toBe('stopped');
	});
});

describe('renaming, Undo and the schedule', () => {
	test("a run renames the books Audible fits, keeping their chapter marks, and leaves the rest", async () => {
		const { abs, books, writes } = fakeAbs();
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => false }));
		const id = runner.start('chapter-names', { dryRun: false }) as number;
		await runner.idle();
		expect(runner.run(id)?.counts).toEqual({ renamed: 1, marksDiffer: 1 });
		expect(books.dune?.media.chapters.map((chapter) => [chapter.start, chapter.title])).toEqual([
			[0, 'Book One: Dune'],
			[500, 'Book Two: Muad’Dib'],
		]);
		expect(books.emma?.media.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1', 'Chapter 2']);
		expect(writes()).toBe(1);
	});

	test("renaming from a check writes what it showed, and leaves a book that changed since", async () => {
		const { abs, books, writes } = fakeAbs();
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => false }));
		const check = runner.start('chapter-names', { dryRun: true }) as number;
		await runner.idle();
		const plan = Object.fromEntries(
			runner.items(check).flatMap((item) => (item.outcome === 'ready' ? [[item.item, { before: item.before, after: item.after }]] : [])),
		);
		expect(Object.keys(plan)).toEqual(['dune']);

		if (books.dune) books.dune.media.chapters[1] = { id: 1, start: 500, end: 1000, title: 'Track 99' };
		const stale = runner.start('chapter-names', { dryRun: false, plan }) as number;
		await runner.idle();
		expect(runner.run(stale)?.counts).toEqual({ changed: 1 });
		expect(writes()).toBe(0);

		if (books.dune) books.dune.media.chapters[1] = { id: 1, start: 500, end: 1000, title: 'Chapter 2' };
		const fresh = runner.start('chapter-names', { dryRun: false, plan }) as number;
		await runner.idle();
		expect(runner.run(fresh)?.counts).toEqual({ renamed: 1 });
		expect(writes()).toBe(1);
	});

	test('a book edited during the Audible lookup is left alone, and nothing is saved after Stop', async () => {
		const edited = fakeAbs((books) => {
			const dune = books.dune as { media: { chapters: { id: number; start: number; end: number; title: string }[] } };
			dune.media.chapters[1] = { id: 1, start: 600, end: 1000, title: 'Chapter 2' };
		});
		const runner = new Runner(':memory:', JOBS, () => ({ abs: edited.abs, region: 'us', auto: () => false }));
		const id = runner.start('chapter-names', { dryRun: false }) as number;
		await runner.idle();
		expect(runner.run(id)?.counts.changed).toBe(1);
		expect(edited.books.dune?.media.chapters[1]?.start).toBe(600);
		expect(edited.writes()).toBe(0);

		let stopping: Runner | null = null;
		const stopped = fakeAbs(() => stopping?.stop());
		stopping = new Runner(':memory:', JOBS, () => ({ abs: stopped.abs, region: 'us', auto: () => false }));
		const run = stopping.start('chapter-names', { dryRun: false }) as number;
		await stopping.idle();
		expect(stopping.run(run)?.status).toBe('stopped');
		expect(stopped.writes()).toBe(0);
	});

	test('Undo puts the old titles back, and leaves a book alone once it changed again', async () => {
		const { abs, books } = fakeAbs();
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => false }));
		const id = runner.start('chapter-names', { dryRun: false }) as number;
		await runner.idle();
		expect(await runner.undo(id, 'dune')).toBeNull();
		expect(books.dune?.media.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1', 'Chapter 2']);
		expect(runner.items(id).find((item) => item.item === 'dune')?.undone).toBe(true);
		expect(await runner.undo(id, 'emma')).toBe('nothing');

		const again = runner.start('chapter-names', { dryRun: false }) as number;
		await runner.idle();
		const renamedTitle = books.dune?.media.chapters[0]?.title ?? '';
		if (books.dune) books.dune.media.chapters[0] = { id: 0, start: 0, end: 499, title: renamedTitle };
		expect(await runner.undo(again, 'dune')).toBe('changed');
		expect(books.dune?.media.chapters[0]?.title).toBe('Book One: Dune');
	});

	test('set to run by itself, it runs hourly and looks again only at books that changed', async () => {
		const { abs, lookups, fetched } = fakeAbs();
		let at = 1_000_000;
		let auto = false;
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => auto }), () => at);
		runner.tick();
		expect(runner.runs()).toHaveLength(0);

		auto = true;
		runner.tick();
		await runner.idle();
		expect(runner.runs()[0]?.counts).toEqual({ renamed: 1, marksDiffer: 1 });
		const [firstLookups, firstFetched] = [lookups(), fetched()];

		at += EVERY / 2;
		runner.tick();
		expect(runner.runs()).toHaveLength(1);

		at += EVERY;
		runner.tick();
		await runner.idle();
		expect(runner.runs()).toHaveLength(2);
		// Nothing changed: no book is read again, nobody asks Audible anything.
		expect(fetched()).toBe(firstFetched);
		expect(lookups()).toBe(firstLookups);
		expect(runner.runs()[0]?.counts).toEqual({});
	});

	test("another Audible store names a book the chosen one can't, and the log says which", async () => {
		const base = fakeAbs();
		const asked: string[] = [];
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			const target = new URL(String(url));
			if (target.pathname === '/api/search/chapters' && target.searchParams.get('asin') === 'B002') {
				const region = target.searchParams.get('region') ?? '';
				asked.push(region);
				if (region === 'ca')
					return Response.json({
						chapters: [
							{ startOffsetMs: 0, lengthMs: 500_000, title: 'Volume I' },
							{ startOffsetMs: 500_000, lengthMs: 500_000, title: 'Volume II' },
						],
						runtimeLengthMs: 1_000_000,
					});
				if (region === 'uk') throw new Error('Audnexus is down.');
			}
			return base.fetcher(url, init);
		}) as typeof fetch;
		const abs = new Audiobookshelf('http://abs:13378', 'abs-key', fetcher);
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => false }));
		const id = runner.start('chapter-names', { dryRun: true }) as number;
		await runner.idle();
		expect(asked).toEqual(['us', 'uk', 'ca']);
		const emma = runner.items(id).find((item) => item.item === 'emma');
		expect(emma?.outcome).toBe('ready');
		expect(emma?.detail).toStartWith('Audible CA: Chapter 1 → Volume I');
		expect(runner.items(id).find((item) => item.item === 'dune')?.detail).toStartWith('Chapter 1 → Book One: Dune');
	});

	test('a store that failed keeps the book unsettled, so the next scheduled run asks again', async () => {
		const base = fakeAbs();
		let down = true;
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			const target = new URL(String(url));
			if (target.pathname === '/api/search/chapters' && target.searchParams.get('asin') === 'B002' && target.searchParams.get('region') === 'uk') {
				if (down) throw new Error('Audnexus is down.');
				return Response.json({
					chapters: [
						{ startOffsetMs: 0, lengthMs: 500_000, title: 'Volume I' },
						{ startOffsetMs: 500_000, lengthMs: 500_000, title: 'Volume II' },
					],
					runtimeLengthMs: 1_000_000,
				});
			}
			return base.fetcher(url, init);
		}) as typeof fetch;
		const abs = new Audiobookshelf('http://abs:13378', 'abs-key', fetcher);
		let at = 1_000_000;
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => true }), () => at);
		runner.tick();
		await runner.idle();
		const first = runner.items(runner.runs()[0]?.id ?? 0).find((item) => item.item === 'emma');
		expect(first?.outcome).toBe('marksDiffer');
		expect(first?.detail).toContain("Audible UK didn't answer");

		down = false;
		at += EVERY;
		runner.tick();
		await runner.idle();
		expect(runner.runs()[0]?.counts).toEqual({ renamed: 1 });
		expect(base.books.emma?.media.chapters.map((chapter) => chapter.title)).toEqual(['Volume I', 'Volume II']);
	});

	test('a book no store fits is logged with the closest answer, after every store was asked', async () => {
		const { abs, lookups } = fakeAbs();
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'uk', auto: () => false }));
		const id = runner.start('chapter-names', { dryRun: true }) as number;
		await runner.idle();
		// Dune fits in the first store asked; Emma is asked of all ten.
		expect(lookups()).toBe(1 + 10);
		const emma = runner.items(id).find((item) => item.item === 'emma');
		expect(emma?.outcome).toBe('marksDiffer');
		expect(emma?.detail).toStartWith('Audible’s chapter 2 starts');
	});

	test('a save whose answer is lost is settled by reading the book back', async () => {
		const base = fakeAbs();
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			const answer = await base.fetcher(url, init);
			if (init?.method === 'POST') throw new Error('The connection was reset.');
			return answer;
		}) as typeof fetch;
		const abs = new Audiobookshelf('http://abs:13378', 'abs-key', fetcher);
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => false }));
		const id = runner.start('chapter-names', { dryRun: false }) as number;
		await runner.idle();
		expect(runner.items(id).find((item) => item.item === 'dune')?.outcome).toBe('renamed');
	});

	test('a rename whose read-back fails is marked not confirmed, and keeps its Undo', async () => {
		const base = fakeAbs();
		let failReads = false;
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'POST') failReads = true;
			else if (failReads && new URL(String(url)).pathname === '/api/items/dune') return new Response('', { status: 500 });
			return base.fetcher(url, init);
		}) as typeof fetch;
		const abs = new Audiobookshelf('http://abs:13378', 'abs-key', fetcher);
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us', auto: () => false }));
		const id = runner.start('chapter-names', { dryRun: false }) as number;
		await runner.idle();
		expect(runner.items(id).find((item) => item.item === 'dune')?.outcome).toBe('unsure');
		failReads = false;
		expect(await runner.undo(id, 'dune')).toBeNull();
		expect(base.books.dune?.media.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1', 'Chapter 2']);
	});

	test('a scheduled run looks again at a book matched since, at every book in another Audible store, and after a week', async () => {
		const { abs, books, fetched } = fakeAbs();
		let at = 1_000_000;
		let region = 'us';
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region, auto: () => true }), () => at);
		runner.tick();
		await runner.idle();
		const first = fetched();

		if (books.emma) books.emma.media.metadata.asin = 'B004';
		at += EVERY;
		runner.tick();
		await runner.idle();
		expect(fetched() - first).toBe(1);

		region = 'uk';
		at += EVERY;
		runner.tick();
		await runner.idle();
		expect(fetched() - first).toBe(1 + 3);

		at += 7 * 86_400_000;
		runner.tick();
		await runner.idle();
		expect(fetched() - first).toBe(1 + 3 + 3);
	});
});
