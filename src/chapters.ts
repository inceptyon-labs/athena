import type { AbsChapter, AudibleChapters } from './abs';

/**
 * Audible's names for a book's own chapters. Only titles change: the book's chapter marks stay. Audible's starts are
 * taken as they are, or moved back by Audible's intro when the file was cut without the intro and outro, whichever
 * fits the book's length within `LENGTH_TOLERANCE`; then Audible must have as many chapters as the book, each
 * starting within `MARK_TOLERANCE` of the book's. Ported from Siren (`SirenKit/Sources/SirenKit/ChapterNames.swift`).
 */
export type Outcome =
	| { kind: 'ready'; chapters: AbsChapter[] }
	/** Audible numbers them too. */
	| { kind: 'noNames' }
	/** Audible's edition is this many seconds longer (negative: shorter). */
	| { kind: 'lengthDiffers'; seconds: number }
	/**
	 * Same length, but Audible's chapters start in different places: a different number of chapters, or the first
	 * chapter (counting from 1) whose start is off, and by how many seconds (positive: Audible's is later).
	 */
	| { kind: 'marksDiffer'; audible: number; book: number; off: { chapter: number; seconds: number } | null }
	| { kind: 'notFound' };

/**
 * How far Audible's length can be from the book's, in seconds. Generous, since every chapter start must also line up
 * within `MARK_TOLERANCE`: a file encoded a little differently is still the same recording.
 */
export const LENGTH_TOLERANCE = 60;
/** How far each of Audible's chapter starts can be from the book's, in seconds. */
export const MARK_TOLERANCE = 2;

const NUMBERED =
	/^(?:(?:chapter|chap|ch|track|part|disc|cd|kapitel|chapitre|capitulo|capítulo|capitolo|hoofdstuk) ?)?\d+(?: ?(?:of )?\d+)?$/u;

/** "Chapter 1", "01", "Track 3", "Book Title - 07": a title that's only a number. */
export function isNumbered(title: string, bookTitle: string): boolean {
	let text = title.toLowerCase();
	const book = bookTitle.toLowerCase().trim();
	if (book) text = text.split(book).join(' ');
	text = text
		.replace(/[-_.:#()[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return text === '' || NUMBERED.test(text);
}

/** Audible's "Opening Credits" and "End Credits": names, but not worth saving on their own. */
export function isCredits(title: string): boolean {
	return ['opening credits', 'end credits', 'credits'].includes(title.toLowerCase().trim());
}

export function match(audible: AudibleChapters, marks: AbsChapter[], duration: number, bookTitle: string): Outcome {
	const items = audible.chapters ?? [];
	if (items.length < 2) return { kind: 'notFound' };
	if (!items.some((item) => !isNumbered(item.title, bookTitle) && !isCredits(item.title))) return { kind: 'noNames' };

	const last = items[items.length - 1];
	const length = (audible.runtimeLengthMs ?? (last ? last.startOffsetMs + last.lengthMs : 0)) / 1000;
	const intro = (audible.brandIntroDurationMs ?? 0) / 1000;
	const outro = (audible.brandOutroDurationMs ?? 0) / 1000;
	// As Audible has it, or without its intro and outro when the file was cut without them.
	const candidates = [{ shift: 0, length }, ...(intro + outro > 0 ? [{ shift: intro, length: length - intro - outro }] : [])].filter(
		(candidate) => Math.abs(duration - candidate.length) <= LENGTH_TOLERANCE,
	);
	if (candidates.length === 0) return { kind: 'lengthDiffers', seconds: length - duration };
	let miss: Outcome | null = null;
	for (const { shift } of candidates) {
		const outcome = lineUp(items, shift, marks, duration);
		if (outcome.kind === 'ready') return outcome;
		miss ??= outcome;
	}
	return miss ?? { kind: 'notFound' };
}

/** Audible's chapters moved back by `shift`, against the book's: its names on the book's marks, or where they differ. */
function lineUp(items: NonNullable<AudibleChapters['chapters']>, shift: number, marks: AbsChapter[], duration: number): Outcome {
	// A chapter that lay wholly inside the trimmed intro (its opening credits) isn't in the file.
	const shifted: { start: number; title: string }[] = [];
	for (const item of items) {
		const start = item.startOffsetMs / 1000 - shift;
		if (start + item.lengthMs / 1000 <= 0 || start >= duration) continue;
		shifted.push({ start: Math.max(0, start), title: item.title });
	}
	if (shifted.length !== marks.length) return { kind: 'marksDiffer', audible: shifted.length, book: marks.length, off: null };
	const index = shifted.findIndex((item, at) => Math.abs(item.start - (marks[at]?.start ?? Number.NaN)) > MARK_TOLERANCE);
	if (index >= 0) {
		const seconds = (shifted[index]?.start ?? 0) - (marks[index]?.start ?? 0);
		return { kind: 'marksDiffer', audible: shifted.length, book: marks.length, off: { chapter: index + 1, seconds } };
	}
	return { kind: 'ready', chapters: marks.map((mark, index) => ({ ...mark, title: shifted[index]?.title ?? mark.title })) };
}
