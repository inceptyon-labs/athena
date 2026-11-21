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
			counted INTEGER NOT NULL
		)`);
		this.db.run('CREATE INDEX IF NOT EXISTS requests_at ON requests (at)');
		this.db.run('CREATE INDEX IF NOT EXISTS requests_viewer ON requests (viewer_id, at)');
	}

	/** Whether these words from this person were answered moments ago, so asking again doesn't count. */
	repeats(viewerId: string, request: string): boolean {
		const row = this.db
			.query('SELECT 1 FROM requests WHERE viewer_id = ? AND request = ? AND status = 200 AND at > ? LIMIT 1')
			.get(viewerId, request, this.now() - PAIRED);
		return row !== null;
	}

	/** Describe Its this person made today. */
	usedToday(viewerId: string): number {
		const row = this.db
			.query('SELECT COUNT(*) AS n FROM requests WHERE viewer_id = ? AND counted = 1 AND at >= ?')
			.get(viewerId, startOfDay(this.now())) as { n: number };
		return row.n;
	}

	/** Everyone who asked today with their Describe Its, most first, under the name they last had. */
	todayByPerson(): { viewerId: string; viewer: string | null; count: number }[] {
		// With MAX(rowid) the only min or max, SQLite takes the bare `viewer` from that latest row.
		return this.db
			.query(
				`SELECT viewer_id AS viewerId, viewer, MAX(rowid) AS last, SUM(counted) AS count FROM requests
				WHERE viewer_id IS NOT NULL AND at >= ? GROUP BY viewer_id ORDER BY count DESC, last DESC`,
			)
			.all(startOfDay(this.now()))
			.map((row) => {
				const { viewerId, viewer, count } = row as { viewerId: string; viewer: string | null; count: number };
				return { viewerId, viewer, count };
			});
	}

	record(entry: Omit<Entry, 'at'>) {
		const at = this.now();
		const counted = entry.status === 200 && !(entry.viewerId && this.repeats(entry.viewerId, entry.request));
		this.db
			.query(
				`INSERT INTO requests (at, viewer_id, viewer, kind, request, picks, suggestions, by, ms, status, error,
				input_tokens, output_tokens, cache_read, cache_write, cost, counted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				at,
				entry.viewerId,
				entry.viewer,
				entry.kind,
				entry.request,
				entry.picks,
				entry.suggestions,
				entry.by,
				entry.ms,
				entry.status,
				entry.error,
				entry.inputTokens,
				entry.outputTokens,
				entry.cacheRead,
				entry.cacheWrite,
				entry.cost,
				counted ? 1 : 0,
			);
		this.db.query('DELETE FROM requests WHERE at < ?').run(at - KEEP);
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
