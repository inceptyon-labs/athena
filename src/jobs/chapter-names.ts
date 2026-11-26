import type { AbsBook } from '../abs';
import { isCredits, isNumbered, match, type Outcome } from '../chapters';
import type { Job, JobContext } from '../jobs';

/** How many books are checked at once: each is one or two requests, and the lookups go on to Audnexus. */
const AT_ONCE = 4;

/**
 * Finds audiobooks whose chapters are only numbered ("Chapter 1", "01", "Track 3") and Audible's names for them, by
 * ASIN through Audiobookshelf. For now every run is a dry run: it logs what it would rename and changes nothing.
 */
export const chapterNames: Job = {
	id: 'chapter-names',
	title: 'Chapter names',
	summary:
		"Finds audiobooks whose chapters are only numbered, like “Chapter 1”, and names them from Audible when Audible's chapters line up with the book's. Only titles change.",
	outcomes: [
		{ id: 'ready', label: 'Names found', note: "Audible's chapters line up with these books' within 2 seconds." },
		{
			id: 'marksDiffer',
			label: 'Chapters break differently',
			note: "Audible's chapters start in different places, so its names wouldn't match. Left alone.",
		},
		{ id: 'lengthDiffers', label: 'Different length', note: "Audible's edition is a different recording. Left alone." },
		{ id: 'noNames', label: 'Numbered on Audible too' },
		{ id: 'notFound', label: 'Not found on Audible', note: "Check the book's ASIN in Audiobookshelf." },
		{ id: 'error', label: "Couldn't check" },
	],
	async run(ctx) {
		const libraries = (await ctx.abs.libraries()).filter((library) => library.mediaType === 'book');
		const books: AbsBook[] = [];
		for (const library of libraries)
			for (const book of await ctx.abs.books(library.id))
				if (book.asin && book.duration > 0 && (book.numChapters ?? 2) > 1) books.push(book);
		ctx.progress(0, books.length);

		let next = 0;
		let checked = 0;
		const worker = async () => {
			while (next < books.length && !ctx.signal.aborted) {
				const book = books[next++] as AbsBook;
				try {
					await check(ctx, book);
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
};

/** Logs a book whose chapters are all numbered, with what Audible has for it. Books with real names aren't logged. */
async function check(ctx: JobContext, listed: AbsBook) {
	const book = await ctx.abs.book(listed.id);
	const chapters = book.chapters;
	if (chapters.length < 2 || !chapters.every((chapter) => isNumbered(chapter.title, book.title))) return;
	const audible = await ctx.abs.audibleChapters(book.asin ?? listed.asin ?? '', ctx.region);
	const outcome = match(audible, chapters, book.duration, book.title);
	ctx.record({
		item: book.id,
		title: book.title,
		outcome: outcome.kind,
		detail: describe(outcome, chapters.length),
		before: chapters.map((chapter) => chapter.title),
		...(outcome.kind === 'ready' ? { after: outcome.chapters } : {}),
	});
}

function describe(outcome: Outcome, count: number): string {
	switch (outcome.kind) {
		case 'ready': {
			const names = outcome.chapters
				.map((chapter) => chapter.title)
				.filter((title) => !isCredits(title))
				.slice(0, 3)
				.join(', ');
			return `${count} chapters: ${names}…`;
		}
		case 'noNames':
			return 'Audible numbers them too.';
		case 'lengthDiffers': {
			const amount = length(Math.abs(outcome.seconds));
			return outcome.seconds > 0 ? `Audible's edition is ${amount} longer.` : `Audible's edition is ${amount} shorter.`;
		}
		case 'marksDiffer':
			return "Audible's chapters start in different places from this book's.";
		case 'notFound':
			return 'Audible has no chapters for its ASIN.';
	}
}

function length(seconds: number) {
	const whole = Math.round(seconds);
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;
	return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
