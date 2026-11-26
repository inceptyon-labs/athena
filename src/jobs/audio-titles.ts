import type { AbsBook, AbsChapter } from '../abs';
import { isNumbered } from '../chapters';
import { CLIP_SECONDS, chapterClips, clipLength, ffmpeg, hasFfmpeg } from '../clips';
import type { Job, JobContext, RunItem } from '../jobs';
import { cost } from '../prices';
import { rename, same } from '../rename';
import { named } from '../titles';
import { length, lookUp, preview, storeName, undoRename } from './chapter-names';

/** How many books a check looks at at once: each is a read and up to ten Audible lookups. */
const AT_ONCE = 4;

/**
 * A chapter as a reading proposes it: its new title, and what was heard just before its mark and at its start, for the
 * owner to judge.
 */
export type Heard = AbsChapter & { lead?: string; heard: string };

/**
 * For books whose chapters are only numbered and that no Audible store can name: cuts the first seconds of each chapter
 * with ffmpeg, turns the speech to text, and has the owner's AI model write the titles the narrator reads. A check
 * lists the books, for free; reading them costs a few cents each; nothing is written until the owner approves a book.
 */
export const audioTitles: Job = {
	id: 'audio-titles',
	title: 'Titles from the audio',
	summary: `For audiobooks whose chapters are only numbered and that no Audible store can name: reads the first ${CLIP_SECONDS} seconds of each chapter, turns the speech into text, and has your AI model write the titles the narrator reads. Nothing changes until you approve a book’s titles.`,
	checks: 'A check lists the books it could read and costs nothing. Reading them is the next step, and nothing is renamed until you approve.',
	scheduled: false,
	next: {
		from: 'readable',
		verb: 'Read',
		hint: 'Reading costs what the estimate says and changes nothing: each book’s titles wait for your approval.',
	},
	outcomes: [
		{
			id: 'proposed',
			label: 'Waiting for you',
			note: 'Titles written from what the narrator says. Open a book’s list to compare each title with what was heard.',
			action: 'Approve to save a book’s titles, or Reject to leave it. Each book is read again first, and left alone if it changed.',
		},
		{
			id: 'numbers',
			label: 'Only numbers read out',
			note: 'The narrator reads only chapter numbers (and the credits), so the titles would only tidy the numbering, such as “001” to “Chapter 1”.',
			action: 'Approve if you prefer these, or Reject to leave the numbers as they are.',
		},
		{
			id: 'renamed',
			label: 'Renamed',
			note: 'These now have the titles you approved, in every app. Undo puts the old ones back.',
			action: 'Nothing to do. If one looks wrong, Undo puts it back.',
		},
		{
			id: 'readable',
			label: 'Can be read',
			note: 'Their chapters are only numbered and no Audible store names them, so the titles can only come from the audio.',
			action: 'Read one, or all of them below. The estimate is what speech to text costs; your AI model adds a fraction of a cent a book.',
		},
		{
			id: 'audible',
			label: 'Audible names these',
			note: 'An Audible store has names that line up with these books’ chapters.',
			action: 'Use Chapter names for these instead: it’s free.',
		},
		{
			id: 'noTitles',
			label: 'Nothing read out',
			note: 'Nothing that sounds like a title was heard at the start of these chapters.',
			action: 'Nothing to do.',
		},
		{
			id: 'rejected',
			label: 'Rejected',
			note: 'You turned these down, so nothing was changed.',
			action: 'Nothing to do. A later check lists them again.',
		},
		{
			id: 'unsure',
			label: 'Not confirmed',
			note: "Audiobookshelf didn't answer after the save, so Athena can't tell if it took. Undo still works if it did.",
			action: 'Open the book in Audiobookshelf to see if the titles took; Undo puts the old ones back if they did.',
		},
		{
			id: 'changed',
			label: 'Changed meanwhile',
			note: 'Their chapters changed since the check, or since they were read, so they were left alone.',
			action: 'Nothing to do. Check again to read them as they are now.',
		},
		{
			id: 'error',
			label: "Couldn't read",
			note: 'Something went wrong reading these.',
			action: 'Check again later, or read them one at a time.',
		},
	],
	undoable: ['renamed', 'unsure'],
	approvable: ['proposed', 'numbers'],

	async run(ctx) {
		if (ctx.plan) return read(ctx, ctx.plan);
		const libraries = (await ctx.abs.libraries()).filter((library) => library.mediaType === 'book');
		const books: AbsBook[] = [];
		for (const library of libraries)
			for (const book of await ctx.abs.books(library.id)) if (book.duration > 0 && (book.numChapters ?? 2) >= 2) books.push(book);
		ctx.progress(0, books.length);
		let next = 0;
		let checked = 0;
		const worker = async () => {
			while (next < books.length && !ctx.signal.aborted) {
				const listed = books[next++] as AbsBook;
				try {
					await check(ctx, listed);
				} catch (error) {
					ctx.record({ item: listed.id, title: listed.title, outcome: 'error', detail: error instanceof Error ? error.message : String(error) });
				}
				ctx.progress(++checked, books.length);
			}
		};
		await Promise.all(Array.from({ length: AT_ONCE }, worker));
	},

	undo: undoRename,

	async apply(abs, item: RunItem) {
		const after = item.after as Heard[] | undefined;
		const before = item.before as string[] | undefined;
		if (!after || !before || before.length !== after.length) throw new Error('There are no titles to save for that book.');
		const expected = after.map(({ id, start, end }, index) => ({ id, start, end, title: before[index] ?? '' }));
		const titled = after.map(({ id, start, end, title }) => ({ id, start, end, title }));
		const result = await rename(abs, item.item, expected, titled);
		if (result === 'changed' || result === 'stopped')
			return { outcome: 'changed', detail: 'Its chapters changed since they were read, so they were left alone.' };
		if (typeof result === 'object') throw new Error(result.error);
		return { outcome: result, detail: item.detail };
	},
};

/** A check: a book whose chapters are all numbered is readable unless an Audible store names it. */
async function check(ctx: JobContext, listed: AbsBook) {
	const book = await ctx.abs.book(listed.id);
	const chapters = book.chapters;
	if (chapters.length < 2 || !chapters.every((chapter) => isNumbered(chapter.title, book.title))) return;
	let why = 'It has no ASIN.';
	if (book.asin) {
		const { outcome, store, missed } = await lookUp(ctx.abs, book.asin, ctx.region, book, ctx.signal);
		if (outcome.kind === 'ready') {
			ctx.record({ item: book.id, title: book.title, outcome: 'audible', detail: `${storeName(store)} names them.` });
			return;
		}
		// A store that didn't answer might name them, for free: don't offer a paid reading until every store has.
		if (missed.length) {
			const who = missed.map(storeName).join(', ');
			ctx.record({ item: book.id, title: book.title, outcome: 'error', detail: `${who} didn't answer, so Athena can't tell yet whether Audible names them. Check again later.` });
			return;
		}
		why = {
			notFound: 'Not on Audible.',
			noNames: 'Audible numbers them too.',
			marksDiffer: 'Audible’s chapters don’t line up.',
			lengthDiffers: 'Audible’s edition is a different length.',
		}[outcome.kind];
	}
	const seconds = chapters.reduce((sum, chapter) => sum + clipLength(chapter), 0);
	const speech = ctx.speech;
	// In credits at the rate the last reading was charged, once there's been one; until then at the list price.
	const rate = Number(ctx.state.get(RATE));
	const estimate = !speech
		? ''
		: !speech.perHour
			? `, free with ${speech.name}`
			: rate > 0
				? `, about ${credits(seconds * rate)} with ${speech.name}`
				: `, about ${price((seconds / 3600) * speech.perHour)} with ${speech.name}`;
	ctx.record({
		item: book.id,
		title: book.title,
		outcome: 'readable',
		detail: `${why} ${chapters.length} chapters: ${length(seconds)} of audio to read${estimate}.`,
		before: chapters.map((chapter) => chapter.title),
		// The chapters as the check saw them, so reading leaves a book that changed since.
		after: chapters,
	});
}

/** Reads the books a check listed, one at a time, and holds what it heard for approval. */
async function read(ctx: JobContext, plan: NonNullable<JobContext['plan']>) {
	const { speech, ai } = ctx;
	const cutter = ctx.cutter ?? (hasFfmpeg() ? ffmpeg : null);
	if (!cutter) throw new Error('Reading the audio needs ffmpeg, which only the speech image has: build Athena with ATHENA_TARGET=speech.');
	if (!speech) throw new Error('Choose speech to text in Settings first.');
	if (!ai?.titles) throw new Error('Set up an AI model in Settings first: it writes the titles from what was heard.');
	const ids = Object.keys(plan);
	ctx.progress(0, ids.length);
	for (const [done, id] of ids.entries()) {
		if (ctx.signal.aborted) break;
		const seen = plan[id]?.after as AbsChapter[] | undefined;
		let title = id;
		try {
			const book = await ctx.abs.book(id);
			title = book.title;
			const before = book.chapters.map((chapter) => chapter.title);
			if (!seen || !same(book.chapters, seen)) {
				ctx.record({ item: id, title, outcome: 'changed', detail: 'Left alone.', before });
			} else {
				const clips = await chapterClips(ctx.abs, book, book.chapters, { format: speech.format, signal: ctx.signal, cutter });
				const { texts, credits: charged } = await speech.transcribe(clips, ctx.signal);
				const leads = book.chapters.map(() => '');
				const heard = book.chapters.map(() => '');
				for (const [index, clip] of clips.entries()) (clip.lead ? leads : heard)[clip.chapter] = texts[index] ?? '';
				const seconds = clips.reduce((sum, clip) => sum + clip.seconds, 0);
				if (charged && seconds > 0) ctx.state.set(RATE, String(charged / seconds));
				const answer = await ai.titles({
					book: book.title,
					author: book.author,
					chapters: book.chapters.map((chapter, index) => ({ now: chapter.title, before: leads[index] ?? '', heard: heard[index] ?? '' })),
				});
				const cut = clips.flatMap((clip) => (clip.error && !clip.lead ? [clip.chapter + 1] : []));
				// A chapter whose opening couldn't be cut keeps its title, whatever the model made of its lead-in.
				const after: Heard[] = book.chapters.map((chapter, index) => ({
					...chapter,
					title: (cut.includes(index + 1) ? null : answer.titles[index]) ?? chapter.title,
					lead: leads[index] ?? '',
					heard: heard[index] ?? '',
				}));
				const titles = after.map((chapter) => chapter.title);
				const spent = (seconds / 3600) * speech.perHour;
				const tidy = cost(ai.by, answer.usage);
				const damaged = cut.length
					? ` ${cut.length === 1 ? `Chapter ${cut[0]}` : `Chapters ${cut.join(', ')}`} couldn't be cut from the audio (${clips.find((clip) => clip.error && !clip.lead)?.error}), so ${cut.length === 1 ? 'it keeps its title' : 'they keep their titles'}.`
					: '';
				const bill = charged !== null ? credits(charged) : spent ? price(spent) : 'free';
				const paid = `Read ${length(seconds)} with ${speech.name} (${bill}), titled by ${ai.by}${tidy === null ? '' : ` (${price(tidy)})`}.${damaged}`;
				const outcome = named(titles, book.title) ? 'proposed' : titles.some((each, index) => each !== before[index]) ? 'numbers' : 'noTitles';
				const detail = outcome === 'noTitles' ? paid : `${preview(before, titles)}. ${paid}`;
				ctx.record({ item: id, title, outcome, detail, before, ...(outcome === 'noTitles' ? {} : { after }) });
			}
		} catch (error) {
			if (ctx.signal.aborted) break;
			ctx.record({ item: id, title, outcome: 'error', detail: error instanceof Error ? error.message : String(error) });
		}
		ctx.progress(done + 1, ids.length);
	}
}

/** Credits ElevenLabs charged per second of audio on the last reading, in `job_state`, for the next estimates. */
const RATE = 'creditsPerSecond';

const credits = (n: number) => `${Math.round(n).toLocaleString('en-US')} credits`;

/** Dollars as cents while under a dollar. */
function price(dollars: number) {
	if (dollars >= 1) return `$${dollars.toFixed(2)}`;
	if (dollars < 0.001) return '<0.1¢';
	return dollars < 0.1 ? `${(dollars * 100).toFixed(1)}¢` : `${Math.round(dollars * 100)}¢`;
}
