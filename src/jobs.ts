import { Database } from 'bun:sqlite';
import type { Audiobookshelf } from './abs';
import { chapterNames } from './jobs/chapter-names';
import { log, warn } from './log';

/** What a job found or did for one item, kept in the run log. */
export type ItemOutcome = {
	item: string;
	title: string;
	/** The job's own word for it, such as `ready` or `notFound`. */
	outcome: string;
	detail: string;
	/** What the item had and what the job would give it (or gave it), for review and, later, Undo. */
	before?: unknown;
	after?: unknown;
};

export interface JobContext {
	abs: Audiobookshelf;
	/** Audible's store for Audnexus lookups. */
	region: string;
	/** Check and log only; change nothing. */
	dryRun: boolean;
	signal: AbortSignal;
	record(outcome: ItemOutcome): void;
	progress(checked: number, total: number): void;
}

/** An automation. Each is one file in `src/jobs/`, listed in `JOBS`. */
export interface Job {
	id: string;
	title: string;
	summary: string;
	/** The outcomes it logs, in the order the run page lists them, with a heading and a line about each. */
	outcomes: { id: string; label: string; note?: string }[];
	run(ctx: JobContext): Promise<void>;
}

export const JOBS: Job[] = [chapterNames];

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped';

export type Run = {
	id: number;
	job: string;
	started: number;
	finished: number | null;
	status: RunStatus;
	dryRun: boolean;
	checked: number;
	total: number;
	error: string | null;
	/** Items logged, by outcome. */
	counts: Record<string, number>;
};

export type RunItem = ItemOutcome & { at: number };

type RunRow = {
	id: number;
	job: string;
	started: number;
	finished: number | null;
	status: RunStatus;
	dry_run: number;
	checked: number;
	total: number;
	error: string | null;
};

/**
 * Runs jobs one at a time in the background and logs each run and what it found, in a SQLite file of its own beside
 * Athena's request log. Nothing runs until the owner connects Audiobookshelf; Describe It never waits on a job.
 */
export class Runner {
	private readonly db: Database;
	private active: { id: number; controller: AbortController; done: Promise<void> } | null = null;

	constructor(
		path: string,
		readonly jobs: Job[],
		private readonly connection: () => { abs: Audiobookshelf | null; region: string },
		private readonly now: () => number = Date.now,
	) {
		this.db = new Database(path, { create: true, strict: true });
		this.db.run(`CREATE TABLE IF NOT EXISTS runs (
			id INTEGER PRIMARY KEY,
			job TEXT NOT NULL,
			started INTEGER NOT NULL,
			finished INTEGER,
			status TEXT NOT NULL,
			dry_run INTEGER NOT NULL,
			checked INTEGER NOT NULL DEFAULT 0,
			total INTEGER NOT NULL DEFAULT 0,
			error TEXT
		)`);
		this.db.run(`CREATE TABLE IF NOT EXISTS run_items (
			run INTEGER NOT NULL,
			item TEXT NOT NULL,
			title TEXT NOT NULL,
			outcome TEXT NOT NULL,
			detail TEXT NOT NULL,
			before TEXT,
			after TEXT,
			at INTEGER NOT NULL
		)`);
		this.db.run('CREATE INDEX IF NOT EXISTS run_items_run ON run_items (run)');
		// Running when Athena last stopped.
		this.db.run(`UPDATE runs SET status = 'stopped', finished = started WHERE status = 'running'`);
	}

	job(id: string): Job | null {
		return this.jobs.find((job) => job.id === id) ?? null;
	}

	/** The run in progress, if any. */
	get running(): Run | null {
		return this.active ? this.run(this.active.id) : null;
	}

	/**
	 * Starts a job in the background and returns its run's id, or why it can't: another run is going, there's no such
	 * job, or Audiobookshelf isn't connected.
	 */
	start(jobId: string, options: { dryRun: boolean }): number | 'busy' | 'unknown' | 'unconnected' {
		const job = this.job(jobId);
		if (!job) return 'unknown';
		if (this.active) return 'busy';
		const { abs, region } = this.connection();
		if (!abs) return 'unconnected';
		const { id } = this.db
			.query('INSERT INTO runs (job, started, status, dry_run) VALUES (?, ?, ?, ?) RETURNING id')
			.get(job.id, this.now(), 'running', options.dryRun ? 1 : 0) as { id: number };
		const controller = new AbortController();
		const ctx: JobContext = {
			abs,
			region,
			dryRun: options.dryRun,
			signal: controller.signal,
			record: (outcome) =>
				this.db
					.query('INSERT INTO run_items (run, item, title, outcome, detail, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
					.run(
						id,
						outcome.item,
						outcome.title,
						outcome.outcome,
						outcome.detail,
						outcome.before === undefined ? null : JSON.stringify(outcome.before),
						outcome.after === undefined ? null : JSON.stringify(outcome.after),
						this.now(),
					),
			progress: (checked, total) => this.db.query('UPDATE runs SET checked = ?, total = ? WHERE id = ?').run(checked, total, id),
		};
		const finish = (status: RunStatus, error: string | null) =>
			this.db.query('UPDATE runs SET status = ?, finished = ?, error = ? WHERE id = ?').run(status, this.now(), error, id);
		log(`job ${job.id} started${options.dryRun ? ' (dry run)' : ''}`);
		const done = job.run(ctx).then(
			() => {
				finish(controller.signal.aborted ? 'stopped' : 'done', null);
				log(`job ${job.id} ${controller.signal.aborted ? 'stopped' : 'finished'}`);
			},
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				finish('failed', message);
				warn(`job ${job.id} failed: ${message}`);
			},
		);
		this.active = {
			id,
			controller,
			done: done.finally(() => {
				this.active = null;
			}),
		};
		return id;
	}

	/** Asks the run in progress to stop after the item it's on. */
	stop() {
		this.active?.controller.abort();
	}

	/** Resolves when no run is going. */
	async idle() {
		await this.active?.done;
	}

	run(id: number): Run | null {
		const row = this.db.query('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | null;
		return row ? this.withCounts(row) : null;
	}

	/** The latest runs, newest first. */
	runs(limit = 20, jobId?: string): Run[] {
		const rows = (
			jobId
				? this.db.query('SELECT * FROM runs WHERE job = ? ORDER BY id DESC LIMIT ?').all(jobId, limit)
				: this.db.query('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit)
		) as RunRow[];
		return rows.map((row) => this.withCounts(row));
	}

	items(runId: number): RunItem[] {
		const rows = this.db
			.query('SELECT item, title, outcome, detail, before, after, at FROM run_items WHERE run = ? ORDER BY title COLLATE NOCASE')
			.all(runId) as (Omit<RunItem, 'before' | 'after'> & { before: string | null; after: string | null })[];
		return rows.map((row) => ({
			...row,
			before: row.before === null ? undefined : JSON.parse(row.before),
			after: row.after === null ? undefined : JSON.parse(row.after),
		}));
	}

	private withCounts(row: RunRow): Run {
		const counts: Record<string, number> = {};
		const tallies = this.db.query('SELECT outcome, COUNT(*) AS n FROM run_items WHERE run = ? GROUP BY outcome').all(row.id) as {
			outcome: string;
			n: number;
		}[];
		for (const tally of tallies) counts[tally.outcome] = tally.n;
		return {
			id: row.id,
			job: row.job,
			started: row.started,
			finished: row.finished,
			status: row.status,
			dryRun: row.dry_run === 1,
			checked: row.checked,
			total: row.total,
			error: row.error,
			counts,
		};
	}
}
