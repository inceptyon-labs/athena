import type { AbsChapter, Audiobookshelf } from './abs';

/** Exactly the same chapters: ids, starts, ends and titles. */
export function same(a: AbsChapter[], b: AbsChapter[]) {
	return (
		a.length === b.length &&
		a.every((chapter, index) => {
			const other = b[index];
			return (
				other !== undefined &&
				chapter.id === other.id &&
				chapter.start === other.start &&
				chapter.end === other.end &&
				chapter.title === other.title
			);
		})
	);
}

/**
 * How a rename went: saved and read back (`renamed`), saved but not read back (`unsure`), left alone because the
 * chapters changed (`changed`) or Stop was pressed (`stopped`), or refused.
 */
export type Renamed = 'renamed' | 'unsure' | 'changed' | 'stopped' | { error: string };

/** Chapter writes waiting or running, by book. */
const writing = new Map<string, Promise<unknown>>();

/**
 * Runs `work` once no other chapter write to the same book is running, so a rename, an approval and an Undo of one book
 * never read the same chapters and then overwrite each other.
 */
export async function oneAtATime<T>(id: string, work: () => Promise<T>): Promise<T> {
	const mine = (writing.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
	writing.set(id, mine);
	try {
		return await mine;
	} finally {
		if (writing.get(id) === mine) writing.delete(id);
	}
}

/**
 * Saves `after` over a book whose chapters are still `expected`, read again just before, and reads it back. A save
 * whose answer is lost may still have been applied, so the read-back decides, and Undo is kept until it does.
 */
export function rename(abs: Audiobookshelf, id: string, expected: AbsChapter[], after: AbsChapter[], signal?: AbortSignal): Promise<Renamed> {
	return oneAtATime(id, () => write(abs, id, expected, after, signal));
}

async function write(abs: Audiobookshelf, id: string, expected: AbsChapter[], after: AbsChapter[], signal?: AbortSignal): Promise<Renamed> {
	const now = await abs.book(id);
	if (!same(now.chapters, expected)) return 'changed';
	if (signal?.aborted) return 'stopped';
	let failed: string | null = null;
	try {
		await abs.saveChapters(id, after);
	} catch (error) {
		failed = error instanceof Error ? error.message : String(error);
	}
	let saved: AbsChapter[];
	try {
		saved = (await abs.book(id)).chapters;
	} catch {
		return 'unsure';
	}
	if (same(saved, after)) return 'renamed';
	return { error: same(saved, expected) && failed ? failed : "Audiobookshelf didn't keep the new names." };
}
