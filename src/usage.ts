import { Database } from 'bun:sqlite';

/** One request to /v1/pick, as the status page lists it. */
export interface Entry {
	at: number;
	/** The Plex account that asked, or null when it couldn't be told. */
	viewerId: string | null;
	viewer: string | null;
	kind: string;
	request: string;
	picks: number;
	suggestions: number;
	/** The model that answered, "jev", or empty when nothing did. */
	by: string;
	ms: number;
	/** 0 while the model is still answering. */
	status: number;
	error: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	/** Estimated dollars, null when the model's price isn't known. */
	cost: number | null;
}

export interface Totals {
	today: number;
	month: number;
	spendToday: number;
	spendMonth: number;
	/** Some of this month's answers came from a model without a known price, so spend is a floor. */
	unpriced: boolean;
}

/** One person's Describe Its, as the status page lists them. */
export interface Person {
	viewerId: string;
	viewer: string | null;
	today: number;
	month: number;
	/** Estimated dollars this month. */
	spend: number;
	/** Some of their answers this month came from a model without a known price, so spend is a floor. */
	unpriced: boolean;
}

/** Who asked what, logged before the model is asked. */
type Asked = Pick<Entry, 'viewerId' | 'viewer' | 'kind' | 'request'>;
/** The answer, filled in once the model has answered or failed. */
type Answered = Omit<Entry, 'at' | keyof Asked>;

/** Ithaca asks for a Describe It's picks and suggestions separately; the same words within this window count once. */
const PAIRED = 2 * 60_000;
/** Kept for a little over a year, so a month can be compared with the same month last year. */
const KEEP = 400 * 86_400_000;

function startOfDay(now: number) {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function startOfMonth(now: number) {
	const date = new Date(startOfDay(now));
	date.setDate(1);
	return date.getTime();
}

/** Every request, in a SQLite file in the data volume. */
export class Usage {
	private readonly db: Database;

	constructor(
		path: string,
		private readonly now: () => number = Date.now,
	) {
		this.db = new Database(path, { create: true, strict: true });
		this.db.run(`CREATE TABLE IF NOT EXISTS requests (
			at INTEGER NOT NULL,
			viewer_id TEXT,
			viewer TEXT,
			kind TEXT NOT NULL,
			request TEXT NOT NULL,
			picks INTEGER NOT NULL,
			suggestions INTEGER NOT NULL,
			by TEXT NOT NULL,
			ms INTEGER NOT NULL,
			status INTEGER NOT NULL,
			error TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read INTEGER NOT NULL,
			cache_write INTEGER NOT NULL,
			cost REAL,
			counted INTEGER NOT NULL,
			paired_with INTEGER
		)`);
		const columns = this.db.query('PRAGMA table_info(requests)').all() as { name: string }[];
		if (!columns.some((column) => column.name === 'paired_with')) this.db.run('ALTER TABLE requests ADD COLUMN paired_with INTEGER');
		this.db.run('CREATE INDEX IF NOT EXISTS requests_at ON requests (at)');
		this.db.run('CREATE INDEX IF NOT EXISTS requests_viewer ON requests (viewer_id, at)');
		// Still answering when Athena last stopped. They keep counting: the model may have been paid for them.
		this.db.run(`UPDATE requests SET status = 502, error = 'Athena stopped before the answer came back.' WHERE status = 0`);
	}

	/**
	 * Logs a request before the model is asked, so requests sent at once see each other. It is paired with an earlier
	 * one from the same person with the same words in the last two minutes that counts and isn't paired yet (Ithaca's
	 * picks and suggestions for one Describe It), and otherwise counts. Past `limit`, unless paired, it is logged as
	 * refused and the answer is null; otherwise the answer is the row for `finish`.
	 */
	start(asked: Asked, limit: number | null): number | null {
		const at = this.now();
		const first = this.db
			.query(
				`SELECT rowid AS id FROM requests AS first WHERE viewer_id = ? AND request = ? AND counted = 1 AND at > ?
				AND NOT EXISTS (SELECT 1 FROM requests WHERE paired_with = first.rowid) ORDER BY at DESC LIMIT 1`,
			)
			.get(asked.viewerId, asked.request, at - PAIRED) as { id: number } | null;
		const over = !first && Boolean(limit) && asked.viewerId !== null && this.usedToday(asked.viewerId) >= (limit ?? 0);
		const row = this.db
			.query(
				`INSERT INTO requests (at, viewer_id, viewer, kind, request, picks, suggestions, by, ms, status, error,
				input_tokens, output_tokens, cache_read, cache_write, cost, counted, paired_with)
				VALUES (?, ?, ?, ?, ?, 0, 0, '', 0, ?, ?, 0, 0, 0, 0, 0, ?, ?)`,
			)
			.run(
				at,
				asked.viewerId,
				asked.viewer,
				asked.kind,
				asked.request,
				over ? 429 : 0,
				over ? 'over the daily limit' : null,
				over || first ? 0 : 1,
				over ? null : (first?.id ?? null),
			);
		return over ? null : Number(row.lastInsertRowid);
	}

	/**
	 * Fills in a started request's answer. It keeps counting only when a model answered, even unusably, since that was
	 * paid for. Otherwise it counts for nothing, and a request paired with it counts in its place.
	 */
	finish(id: number, answered: Answered) {
		const row = this.db.query('SELECT counted, paired_with AS pairedWith FROM requests WHERE rowid = ?').get(id) as {
			counted: number;
			pairedWith: number | null;
		} | null;
		if (!row) return;
		const paid = answered.by !== '';
		this.db
			.query(
				`UPDATE requests SET picks = ?, suggestions = ?, by = ?, ms = ?, status = ?, error = ?, input_tokens = ?,
				output_tokens = ?, cache_read = ?, cache_write = ?, cost = ?, counted = ?, paired_with = ? WHERE rowid = ?`,
			)
			.run(
				answered.picks,
				answered.suggestions,
				answered.by,
				answered.ms,
				answered.status,
				answered.error,
				answered.inputTokens,
				answered.outputTokens,
				answered.cacheRead,
				answered.cacheWrite,
				answered.cost,
				paid ? row.counted : 0,
				paid ? row.pairedWith : null,
				id,
			);
		if (!paid && row.counted)
			this.db
				.query('UPDATE requests SET counted = 1, paired_with = NULL WHERE rowid = (SELECT rowid FROM requests WHERE paired_with = ? LIMIT 1)')
				.run(id);
		this.db.query('DELETE FROM requests WHERE at < ?').run(this.now() - KEEP);
	}

	/** Describe Its this person made today. */
	usedToday(viewerId: string): number {
		const row = this.db
			.query('SELECT COUNT(*) AS n FROM requests WHERE viewer_id = ? AND counted = 1 AND at >= ?')
			.get(viewerId, startOfDay(this.now())) as { n: number };
		return row.n;
	}

	/**
	 * The average prompt of the last 30 days' answers from an AI model, in tokens: about the library's size, which sets
	 * what a Describe It costs. Null until there are a few.
	 */
	promptSize(): number | null {
		const row = this.db
			.query(
				`SELECT AVG(input_tokens + cache_read + cache_write) AS size, COUNT(*) AS n FROM requests
				WHERE status = 200 AND by != '' AND by != 'jev' AND at >= ?`,
			)
			.get(this.now() - 30 * 86_400_000) as { size: number | null; n: number };
		return row.n >= 3 && row.size ? Math.round(row.size) : null;
	}

	/**
	 * Everyone who asked this month, under the name they last had, with their Describe Its today and this month and
	 * the estimated spend on them this month. Most today first, then most this month.
	 */
	byPerson(): Person[] {
		const now = this.now();
		// With MAX(rowid) the only min or max, SQLite takes the bare `viewer` from that latest row.
		return this.db
			.query(
				`SELECT viewer_id AS viewerId, viewer, MAX(rowid) AS last,
				COALESCE(SUM(CASE WHEN at >= ? THEN counted END), 0) AS today, SUM(counted) AS month,
				COALESCE(SUM(cost), 0) AS spend, SUM(cost IS NULL AND by != '') AS unpriced
				FROM requests WHERE viewer_id IS NOT NULL AND at >= ? GROUP BY viewer_id
				ORDER BY today DESC, month DESC, last DESC`,
			)
			.all(startOfDay(now), startOfMonth(now))
			.map((row) => {
				const { viewerId, viewer, today, month, spend, unpriced } = row as Omit<Person, 'unpriced'> & { unpriced: number };
				return { viewerId, viewer, today, month, spend, unpriced: unpriced > 0 };
			});
	}

	/** Logs a request that has already been answered. */
	record(entry: Omit<Entry, 'at'>) {
		const id = this.start(entry, null);
		if (id !== null) this.finish(id, entry);
	}

	/** Describe Its and estimated spend, today and this calendar month, in the server's time zone. */
	totals(): Totals {
		const now = this.now();
		const sum = (since: number) =>
			this.db
				.query(
					`SELECT COALESCE(SUM(counted), 0) AS n, COALESCE(SUM(cost), 0) AS spend,
					COALESCE(SUM(cost IS NULL AND by != ''), 0) AS unpriced FROM requests WHERE at >= ?`,
				)
				.get(since) as { n: number; spend: number; unpriced: number };
		const day = sum(startOfDay(now));
		const month = sum(startOfMonth(now));
		return {
			today: day.n,
			month: month.n,
			spendToday: day.spend,
			spendMonth: month.spend,
			unpriced: month.unpriced > 0,
		};
	}

	recent(limit = 50): Entry[] {
		return this.db
			.query(
				`SELECT at, viewer_id AS viewerId, viewer, kind, request, picks, suggestions, by, ms, status, error,
				input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read AS cacheRead,
				cache_write AS cacheWrite, cost FROM requests ORDER BY at DESC, rowid DESC LIMIT ?`,
			)
			.all(limit) as Entry[];
	}

	close() {
		this.db.close();
	}
}
