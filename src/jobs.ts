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
	/** What the item had and what the job would give it (or gave it), for review and Undo. */
	before?: unknown;
	after?: unknown;
};

/** Who started a run: the owner, from the Automations page, or the hourly schedule. */
export type Trigger = 'manual' | 'schedule';

export interface JobContext {
	abs: Audiobookshelf;
	/** Audible's store for Audnexus lookups. */
	region: string;
	/** Check and log only; change nothing. */
	dryRun: boolean;
	/**
	 * What a check found, by item, when renaming from its results: the job does just those, as they were shown, and
	 * leaves any item that changed since. Null otherwise.
	 */
	plan: Record<string, { before: unknown; after: unknown }> | null;
	/** Skip items unchanged since this job last looked at them (scheduled runs). */
	incremental: boolean;
	signal: AbortSignal;
	now(): number;
	record(outcome: ItemOutcome): void;
	progress(checked: number, total: number): void;
	/** The job's own notes between runs, such as when it last looked at each item. */
	state: { get(key: string): string | null; set(key: string, value: string): void };
}

/** An automation. Each is one file in `src/jobs/`, listed in `JOBS`. */
export interface Job {
	id: string;
	title: string;
	summary: string;
	/**
	 * The outcomes it logs, in the order the run page lists them: a heading, what it means, and what the owner can do
	 * about it (even if that's nothing).
	 */
	outcomes: { id: string; label: string; note?: string; action?: string }[];
	/** The outcomes Undo applies to, if the job can undo what it did. */
	undoable?: string[];
	run(ctx: JobContext): Promise<void>;
	/** Puts one item back as `before` had it. Resolves to `changed` when it changed since, so it was left alone. */
	undo?(abs: Audiobookshelf, item: RunItem): Promise<'changed' | null>;
}

export const JOBS: Job[] = [chapterNames];

/** How often a job set to run by itself runs. */
export const EVERY = 60 * 60_000;

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped';

export type Run = {
	id: number;
	job: string;
	started: number;
	finished: number | null;
	status: RunStatus;
	dryRun: boolean;
	trigger: Trigger;
	checked: number;
	total: number;
	error: string | null;
	/** Items logged, by outcome. */
	counts: Record<string, number>;
};

export type RunItem = ItemOutcome & { at: number; undone: boolean };

type RunRow = {
	id: number;
	job: string;
	started: number;
	finished: number | null;
	status: RunStatus;
	dry_run: number;
	trigger: Trigger;
	checked: number;
	total: number;
	error: string | null;
};

/** Where a job's settings and the Audiobookshelf connection come from, read at each run. */
export type Connection = () => { abs: Audiobookshelf | null; region: string; auto: (jobId: string) => boolean };

/**
 * Runs jobs one at a time in the background and logs each run and what it found, in a SQLite file of its own beside
 * Athena's request log. Nothing runs until the owner connects Audiobookshelf; Describe It never waits on a job.
 */
export class Runner {
	private readonly db: Database;
	private active: { id: number; controller: AbortController; done: Promise<void> } | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		path: string,
		readonly jobs: Job[],
		private readonly connection: Connection,
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
			trigger TEXT NOT NULL DEFAULT 'manual',
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
			at INTEGER NOT NULL,
			undone INTEGER NOT NULL DEFAULT 0
		)`);
		this.db.run('CREATE TABLE IF NOT EXISTS job_state (job TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (job, key))');
		// Logs from before Rename and the schedule.
		const has = (table: string, column: string) =>
			(this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((each) => each.name === column);
		if (!has('runs', 'trigger')) this.db.run(`ALTER TABLE runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual'`);
		if (!has('run_items', 'undone')) this.db.run('ALTER TABLE run_items ADD COLUMN undone INTEGER NOT NULL DEFAULT 0');
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
	start(
		jobId: string,
		options: { dryRun: boolean; plan?: JobContext['plan']; trigger?: Trigger },
	): number | 'busy' | 'unknown' | 'unconnected' {
		const job = this.job(jobId);
		if (!job) return 'unknown';
		if (this.active) return 'busy';
		const { abs, region } = this.connection();
		if (!abs) return 'unconnected';
		const trigger = options.trigger ?? 'manual';
		const { id } = this.db
			.query('INSERT INTO runs (job, started, status, dry_run, trigger) VALUES (?, ?, ?, ?, ?) RETURNING id')
			.get(job.id, this.now(), 'running', options.dryRun ? 1 : 0, trigger) as { id: number };
		const controller = new AbortController();
		const ctx: JobContext = {
			abs,
			region,
			dryRun: options.dryRun,
			plan: options.plan ?? null,
			incremental: trigger === 'schedule',
			signal: controller.signal,
			now: this.now,
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
			state: {
				get: (key) =>
					(this.db.query('SELECT value FROM job_state WHERE job = ? AND key = ?').get(job.id, key) as { value: string } | null)
						?.value ?? null,
				set: (key, value) =>
					this.db
						.query('INSERT INTO job_state (job, key, value) VALUES (?, ?, ?) ON CONFLICT (job, key) DO UPDATE SET value = excluded.value')
						.run(job.id, key, value),
			},
		};
		const finish = (status: RunStatus, error: string | null) =>
			this.db.query('UPDATE runs SET status = ?, finished = ?, error = ? WHERE id = ?').run(status, this.now(), error, id);
		const what = `${job.id}${options.dryRun ? ' (check)' : ''}${trigger === 'schedule' ? ' on schedule' : ''}`;
		log(`job ${what} started`);
		const done = job.run(ctx).then(
			() => {
				finish(controller.signal.aborted ? 'stopped' : 'done', null);
				log(`job ${what} ${controller.signal.aborted ? 'stopped' : 'finished'}`);
			},
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				finish('failed', message);
				warn(`job ${what} failed: ${message}`);
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

	/** Starts each job set to run by itself whose last scheduled run began an hour ago or more. Called every minute. */
	tick() {
		const { abs, auto } = this.connection();
		if (!abs || this.active) return;
		for (const job of this.jobs) {
			if (!auto(job.id)) continue;
			const last = this.db
				.query(`SELECT started FROM runs WHERE job = ? AND trigger = 'schedule' ORDER BY id DESC LIMIT 1`)
				.get(job.id) as { started: number } | null;
			if (last && this.now() - last.started < EVERY) continue;
			this.start(job.id, { dryRun: false, trigger: 'schedule' });
			return;
		}
	}

	/** Checks the schedule every minute, from `main` only. */
	schedule() {
		this.timer ??= setInterval(() => this.tick(), 60_000);
	}

	/** Puts one item from a run back as it was. Resolves to why it couldn't, or null once done. */
	async undo(runId: number, itemId: string): Promise<'nothing' | 'unconnected' | 'changed' | null> {
		const run = this.run(runId);
		const job = run ? this.job(run.job) : null;
		const { abs } = this.connection();
		if (!run || !job?.undo || !job.undoable) return 'nothing';
		if (!abs) return 'unconnected';
		const undoable = job.undoable;
		const item = this.items(runId).find((each) => each.item === itemId && undoable.includes(each.outcome));
		if (!item) return 'nothing';
		if (item.undone) return null;
		const problem = await job.undo(abs, item);
		if (problem === null)
			this.db.query('UPDATE run_items SET undone = 1 WHERE run = ? AND item = ? AND outcome = ?').run(runId, itemId, item.outcome);
		return problem;
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
			.query(
				'SELECT item, title, outcome, detail, before, after, at, undone FROM run_items WHERE run = ? ORDER BY title COLLATE NOCASE',
			)
			.all(runId) as (Omit<RunItem, 'before' | 'after' | 'undone'> & { before: string | null; after: string | null; undone: number })[];
		return rows.map((row) => ({
			...row,
			before: row.before === null ? undefined : JSON.parse(row.before),
			after: row.after === null ? undefined : JSON.parse(row.after),
			undone: row.undone === 1,
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
			trigger: row.trigger,
			checked: row.checked,
			total: row.total,
			error: row.error,
			counts,
		};
	}
}
