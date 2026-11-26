import type { AbsBook, AbsChapter } from '../abs';
import { isCredits, isNumbered, match, type Outcome } from '../chapters';
import type { Job, JobContext } from '../jobs';

/** How many books are checked at once: each is one or two requests, and the lookups go on to Audnexus. */
const AT_ONCE = 4;
/**
 * How long a scheduled run trusts that a book it settled hasn't changed. Audiobookshelf doesn't always move a book's
 * `updatedAt` when only its chapters are edited, so every book is looked at again at least this often.
 */
const RECHECK = 7 * 86_400_000;

/**
 * Finds audiobooks whose chapters are only numbered ("Chapter 1", "01", "Track 3") and names them from Audible, by
 * ASIN through Audiobookshelf, when Audible's chapters line up with the book's. Only titles change. A check logs what
 * it would rename; a run renames, reading each book again just before and after.
 */
export const chapterNames: Job = {
	id: 'chapter-names',
	title: 'Chapter names',
	summary:
		"Finds audiobooks whose chapters are only numbered, like “Chapter 1”, and names them from Audible when Audible's chapters line up with the book's. Only titles change.",
	outcomes: [
		{
			id: 'renamed',
			label: 'Renamed',
			note: 'These now have Audible’s chapter names, in every app. Undo puts the old titles back.',
		},
		{
			id: 'ready',
			label: 'Can be renamed',
			note: 'Audible has names for these books, and its chapters start where the book’s do, so only the titles change. Rename to use them.',
		},
		{
			id: 'unsure',
			label: 'Not confirmed',
			note: "Audiobookshelf didn't answer after the save, so Athena can't tell if it took. Undo still works if it did.",
		},
		{
			id: 'changed',
			label: 'Changed meanwhile',
			note: 'Their chapters changed while Athena was looking, or since the check, so they were left alone. The next check looks again.',
		},
		{
			id: 'marksDiffer',
			label: 'Chapters don’t line up',
			note: 'Audible splits these books into chapters in different places, so its names would land on the wrong chapters. Left alone.',
		},
		{
			id: 'lengthDiffers',
			label: 'Different recording',
			note: 'Audible’s edition is a different length, so it’s probably another recording (abridged, another narrator), or the book’s ASIN in Audiobookshelf points at the wrong book. Open the book to check its ASIN.',
		},
		{
			id: 'noNames',
			label: 'Audible numbers them too',
			note: 'Audible’s chapters for these are only numbers as well, so there’s nothing better to use.',
		},
		{
			id: 'notFound',
			label: 'Not on Audible',
			note: 'Audible has no chapter list for the ASIN Audiobookshelf has for these. Open the book to check its ASIN.',
		},
		{ id: 'error', label: "Couldn't check", note: 'Something went wrong asking Audiobookshelf. The next check tries again.' },
	],
	undoable: ['renamed', 'unsure'],
	async run(ctx) {
		const libraries = (await ctx.abs.libraries()).filter((library) => library.mediaType === 'book');
		const books: AbsBook[] = [];
		for (const library of libraries)
			for (const book of await ctx.abs.books(library.id)) {
				if (!book.asin || book.duration <= 0 || (book.numChapters ?? 2) < 2) continue;
				if (ctx.plan && !ctx.plan[book.id]) continue;
				if (ctx.incremental && unchanged(ctx, book)) continue;
				books.push(book);
			}
		ctx.progress(0, books.length);

		let next = 0;
		let checked = 0;
		const worker = async () => {
			while (next < books.length && !ctx.signal.aborted) {
				const book = books[next++] as AbsBook;
				try {
					const planned = ctx.plan?.[book.id];
					const settled = planned ? await rename(ctx, book, planned) : await check(ctx, book);
					if (settled) ctx.state.set(seenKey(book.id), JSON.stringify({ print: fingerprint(book, ctx.region), at: ctx.now() }));
				} catch (error) {
					ctx.record({
						item: book.id,
						title: book.title,
						outcome: 'error',
						detail: error instanceof Error ? error.message : String(error),
					});
				}
				ctx.progress(++checked, books.length);
			}
		};
		await Promise.all(Array.from({ length: AT_ONCE }, worker));
	},

	async undo(abs, item) {
		const after = item.after as AbsChapter[] | undefined;
		const before = item.before as string[] | undefined;
		if (!after || !before || before.length !== after.length) return 'changed';
		const book = await abs.book(item.item);
		if (!same(book.chapters, after)) return 'changed';
		await abs.saveChapters(
			book.id,
			book.chapters.map((chapter, index) => ({ ...chapter, title: before[index] ?? chapter.title })),
		);
		return null;
	},
};

const seenKey = (id: string) => `seen:${id}`;

/**
 * What the library listing says about a book that would change when it's matched, re-chaptered or replaced, and the
 * Audible store it was looked up in.
 */
const fingerprint = (book: AbsBook, region: string) =>
	[book.updatedAt, book.asin, book.numChapters, book.duration, region].join('|');

/** Settled by an earlier run, listed the same since, and looked at within `RECHECK`. */
function unchanged(ctx: JobContext, book: AbsBook) {
	const seen = ctx.state.get(seenKey(book.id));
	if (!seen) return false;
	try {
		const { print, at } = JSON.parse(seen) as { print: string; at: number };
		return print === fingerprint(book, ctx.region) && ctx.now() - at < RECHECK;
	} catch {
		return false;
	}
}

/** Exactly the same chapters: ids, starts, ends and titles. */
function same(a: AbsChapter[], b: AbsChapter[]) {
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
 * Saves `after` over a book whose chapters are still `expected`, read again just before, and reads it back. Resolves
 * to false, saving nothing, once Stop was pressed or the chapters changed.
 */
async function save(ctx: JobContext, book: AbsBook, expected: AbsChapter[], after: AbsChapter[], detail: string) {
	const before = expected.map((chapter) => chapter.title);
	const now = await ctx.abs.book(book.id);
	if (!same(now.chapters, expected)) {
		ctx.record({ item: book.id, title: book.title, outcome: 'changed', detail: 'Left alone.', before });
		return false;
	}
	if (ctx.signal.aborted) return false;
	// A save whose answer is lost may still have been applied, so the read-back decides, and Undo is kept until it does.
	let failed: string | null = null;
	try {
		await ctx.abs.saveChapters(book.id, after);
	} catch (error) {
		failed = error instanceof Error ? error.message : String(error);
	}
	let saved: AbsBook;
	try {
		saved = await ctx.abs.book(book.id);
	} catch {
		ctx.record({ item: book.id, title: book.title, outcome: 'unsure', detail, before, after });
		return false;
	}
	if (same(saved.chapters, after)) {
		ctx.record({ item: book.id, title: book.title, outcome: 'renamed', detail, before, after });
		return true;
	}
	const why = same(saved.chapters, expected) && failed ? failed : "Audiobookshelf didn't keep the new names.";
	ctx.record({ item: book.id, title: book.title, outcome: 'error', detail: why, before });
	return false;
}

/** Renames a book as a check showed it, if it hasn't changed since. */
async function rename(ctx: JobContext, listed: AbsBook, planned: { before: unknown; after: unknown }) {
	const after = planned.after as AbsChapter[] | undefined;
	const before = planned.before as string[] | undefined;
	if (!after || !before || before.length !== after.length) return false;
	// The chapters as the check saw them: its marks, with the titles they had.
	const checked = after.map((chapter, index) => ({ ...chapter, title: before[index] ?? '' }));
	return save(ctx, listed, checked, after, describe({ kind: 'ready', chapters: after }, before));
}

/**
 * Checks one book and, outside a check, renames it. Resolves to whether its state is settled, so a scheduled run can
 * skip it until Audiobookshelf changes it: false while a check leaves names to rename.
 */
async function check(ctx: JobContext, listed: AbsBook): Promise<boolean> {
	const book = await ctx.abs.book(listed.id);
	const chapters = book.chapters;
	if (chapters.length < 2 || !chapters.every((chapter) => isNumbered(chapter.title, book.title))) return true;
	const audible = await ctx.abs.audibleChapters(book.asin ?? listed.asin ?? '', ctx.region);
	const outcome = match(audible, chapters, book.duration, book.title);
	const before = chapters.map((chapter) => chapter.title);
	if (outcome.kind !== 'ready' || ctx.dryRun) {
		ctx.record({
			item: book.id,
			title: book.title,
			outcome: outcome.kind,
			detail: describe(outcome, before),
			before,
			...(outcome.kind === 'ready' ? { after: outcome.chapters } : {}),
		});
		return outcome.kind !== 'ready';
	}

	return save(ctx, book, chapters, outcome.chapters, describe(outcome, before));
}

/** What the run log says about a book, in a line. */
function describe(outcome: Outcome, before: string[]): string {
	switch (outcome.kind) {
		case 'ready':
			return preview(before, outcome.chapters.map((chapter) => chapter.title));
		case 'noNames':
			return 'Audible’s chapters are numbered too.';
		case 'lengthDiffers': {
			const amount = length(Math.abs(outcome.seconds));
			return outcome.seconds > 0 ? `Audible’s edition is ${amount} longer.` : `Audible’s edition is ${amount} shorter.`;
		}
		case 'marksDiffer':
			if (!outcome.off) return `Audible has ${outcome.audible} chapters; this book has ${outcome.book}.`;
			return `Audible’s chapter ${outcome.off.chapter} starts ${length(Math.abs(outcome.off.seconds))} ${outcome.off.seconds > 0 ? 'later' : 'earlier'} than this book’s.`;
		case 'notFound':
			return 'Audible has no chapter list for its ASIN.';
	}
}

/**
 * The renames that matter, such as "001 → Opening Credits, 002 → Chapter 1, …, 036 → Epilogue (37 of 37 titles
 * change)": the first two changes, then up to four names that aren't only a number.
 */
export function preview(before: string[], after: string[]) {
	const changes = after.flatMap((title, index) => (title === before[index] ? [] : [{ index, text: `${before[index] ?? ''} → ${title}` }]));
	if (changes.length === 0) return 'No titles would change.';
	const first = changes.slice(0, 2);
	const named = changes.slice(2).filter((change) => !isNumbered(after[change.index] ?? '', '')).slice(0, 4);
	const parts = first.map((change) => change.text);
	if (changes.length > first.length + named.length) parts.push('…');
	parts.push(...named.map((change) => change.text));
	return `${parts.join(', ')} (${changes.length} of ${after.length} titles change)`;
}

function length(seconds: number) {
	const whole = Math.round(seconds);
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;
	return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

