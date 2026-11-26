import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Audiobookshelf } from '../src/abs';
import { JOBS, Runner } from '../src/jobs';
import { fakeAbs } from './helpers';

describe('the job runner', () => {
	test("a check logs the numbered books with Audible's answer, and writes nothing", async () => {
		const { abs, writes } = fakeAbs();
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us' }));
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
		const runner = new Runner(':memory:', JOBS, () => ({ abs, region: 'us' }));
		runner.start('chapter-names', { dryRun: true });
		expect(runner.start('chapter-names', { dryRun: true })).toBe('busy');
		await runner.idle();
		expect(runner.start('nothing', { dryRun: true })).toBe('unknown');
		expect(new Runner(':memory:', JOBS, () => ({ abs: null, region: 'us' })).start('chapter-names', { dryRun: true })).toBe(
			'unconnected',
		);
	});

	test('a rejected API key fails the run with why', async () => {
		const wrong = new Audiobookshelf('http://abs:13378', 'wrong', fakeAbs().fetcher);
		const runner = new Runner(':memory:', JOBS, () => ({ abs: wrong, region: 'us' }));
		const id = runner.start('chapter-names', { dryRun: true }) as number;
		await runner.idle();
		expect(runner.run(id)?.status).toBe('failed');
		expect(runner.run(id)?.error).toBe('Audiobookshelf turned the API key down.');
	});

	test('a run still going when Athena stopped is marked stopped', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'athena-jobs-')), 'jobs.db');
		const { abs } = fakeAbs();
		const first = new Runner(path, JOBS, () => ({ abs, region: 'us' }));
		const id = first.start('chapter-names', { dryRun: true }) as number;
		const after = new Runner(path, JOBS, () => ({ abs, region: 'us' }));
		expect(after.run(id)?.status).toBe('stopped');
	});
});
