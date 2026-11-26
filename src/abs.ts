/** A book's chapter, as Audiobookshelf keeps it: start and end in seconds. */
export type AbsChapter = { id: number; start: number; end: number; title: string };

/** One of a book's audio files, where it falls in the book, and its path for streaming (`/api/items/<id>/file/<ino>`). */
export type AbsTrack = { startOffset: number; duration: number; contentUrl: string };

export type AbsBook = {
	id: string;
	title: string;
	author: string | null;
	asin: string | null;
	/** Seconds. */
	duration: number;
	/** In the library listing, which leaves the chapters out. */
	numChapters: number | null;
	/** When Audiobookshelf last changed the book, in milliseconds; a matched or edited book moves it on. */
	updatedAt: number | null;
	/** Only from `book`. */
	chapters: AbsChapter[];
	/** Only from `book`. */
	tracks: AbsTrack[];
};

export type AbsLibrary = { id: string; name: string; mediaType: string };

/** The user the API key belongs to. */
export type AbsUser = { id: string; username: string; type: string; canUpdate: boolean };

/** Audible's chapters for an ASIN, from Audnexus through Audiobookshelf; `{ error }` when it has none. */
export type AudibleChapters = {
	chapters?: { startOffsetMs: number; lengthMs: number; title: string }[];
	runtimeLengthMs?: number;
	brandIntroDurationMs?: number;
	brandOutroDurationMs?: number;
	error?: string;
};

export class AbsError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

/** Audiobookshelf's address as the owner typed it, or null unless it's a plain http(s) address. */
export function absBase(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
	return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

type RawBook = {
	id: string;
	updatedAt?: number;
	media?: {
		duration?: number;
		numChapters?: number;
		chapters?: AbsChapter[];
		tracks?: AbsTrack[];
		metadata?: { title?: string; authorName?: string | null; asin?: string | null };
	};
};

function bookOf(raw: RawBook): AbsBook {
	const metadata = raw.media?.metadata ?? {};
	return {
		id: raw.id,
		title: metadata.title ?? '',
		author: metadata.authorName ?? null,
		asin: metadata.asin?.trim() || null,
		duration: raw.media?.duration ?? 0,
		numChapters: raw.media?.numChapters ?? raw.media?.chapters?.length ?? null,
		chapters: raw.media?.chapters ?? [],
		tracks: (raw.media?.tracks ?? []).map(({ startOffset, duration, contentUrl }) => ({ startOffset, duration, contentUrl })),
		updatedAt: raw.updatedAt ?? null,
	};
}

/** Audiobookshelf's API, as the user whose API key the owner gave Athena. */
export class Audiobookshelf {
	constructor(
		readonly url: string,
		private readonly key: string,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	private get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
		return this.request<T>('GET', path, query);
	}

	private async request<T>(method: 'GET' | 'POST', path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
		const search = new URLSearchParams(query).toString();
		let response: Response;
		try {
			response = await this.fetcher(`${this.url}${path}${search ? `?${search}` : ''}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.key}`,
					Accept: 'application/json',
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (error) {
			throw new AbsError(`Audiobookshelf at ${this.url} didn't answer: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (response.status === 401 || response.status === 403)
			throw new AbsError('Audiobookshelf turned the API key down.', response.status);
		if (!response.ok) throw new AbsError(`Audiobookshelf answered ${response.status} for ${path}.`, response.status);
		return (await response.json()) as T;
	}

	async me(): Promise<AbsUser> {
		const user = await this.get<{ id: string; username: string; type: string; permissions?: { update?: boolean } }>('/api/me');
		const admin = user.type === 'root' || user.type === 'admin';
		return { id: user.id, username: user.username, type: user.type, canUpdate: admin || Boolean(user.permissions?.update) };
	}

	async libraries(): Promise<AbsLibrary[]> {
		const answer = await this.get<{ libraries: AbsLibrary[] }>('/api/libraries');
		return answer.libraries.map(({ id, name, mediaType }) => ({ id, name, mediaType }));
	}

	/** Every book in a library, without their chapters. */
	async books(libraryId: string): Promise<AbsBook[]> {
		const answer = await this.get<{ results: RawBook[] }>(`/api/libraries/${encodeURIComponent(libraryId)}/items`, {
			minified: '1',
		});
		return answer.results.map(bookOf);
	}

	/** How many books a library has. */
	async count(libraryId: string): Promise<number> {
		const answer = await this.get<{ total?: number }>(`/api/libraries/${encodeURIComponent(libraryId)}/items`, {
			limit: '1',
			minified: '1',
		});
		return answer.total ?? 0;
	}

	/** One book, with its chapters. */
	async book(id: string): Promise<AbsBook> {
		return bookOf(await this.get<RawBook>(`/api/items/${encodeURIComponent(id)}`, { expanded: '1' }));
	}

	/**
	 * Where ffmpeg reads one of a book's files, with the header that lets it in: the API key, so never log either.
	 * Audiobookshelf answers range requests, so ffmpeg seeks without reading the whole file.
	 */
	trackInput(track: AbsTrack): { url: string; headers: string } {
		return { url: `${this.url}${track.contentUrl}`, headers: `Authorization: Bearer ${this.key}\r\n` };
	}

	audibleChapters(asin: string, region: string): Promise<AudibleChapters> {
		return this.get<AudibleChapters>('/api/search/chapters', { asin, region });
	}

	/** Replaces a book's chapters, for every app. Needs a user who can update books. */
	async saveChapters(id: string, chapters: AbsChapter[]): Promise<void> {
		await this.request('POST', `/api/items/${encodeURIComponent(id)}/chapters`, {}, {
			chapters: chapters.map(({ id: chapterId, start, end, title }) => ({ id: chapterId, start, end, title })),
		});
	}
}
