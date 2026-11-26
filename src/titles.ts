import { z } from 'zod';
import { isNumbered } from './chapters';

/**
 * Titles from the audio: what the narrator says at the start of each chapter, turned into the book's chapter titles by
 * the AI model the owner chose. Claude can't take audio, so speech to text comes first (`src/speech.ts`).
 */

export type TitlesRequest = {
	book: string;
	author: string | null;
	/** Each chapter's current title, what was heard just before its mark, and in its first seconds, in order. */
	chapters: { now: string; before: string; heard: string }[];
};

/** Each title with its chapter's number, so a title can't slip onto the chapter next to it. */
export const TitlesResult = z.object({ titles: z.array(z.object({ chapter: z.number().int(), title: z.string().nullable() })) });

export const TITLES_SYSTEM = `You name an audiobook's chapters from what the narrator says at the start of each one.

You get the book's title and author, and for each chapter in order, its number, its current title (only a number), and transcripts made by speech to text: "Before" is the few seconds before the chapter's mark, which is usually the end of the chapter before but holds the start of the title when the mark is a little late, and "Heard" is the chapter's first seconds. Transcripts may misspell names.

For each chapter, give its title as the book's table of contents would list it, from the narrator's words:
- A chapter read with a number and a name: "Chapter 12: The Long Night". Write the number in digits.
- A name alone, or a part, prologue or epilogue: "The Long Night", "Part Two: The Sea", "Prologue", "Epilogue".
- Only a number read out: "Chapter 12".
- Opening credits ("This is Audible", the title, author and narrator read out): "Opening Credits". Closing credits: "End Credits".
- Nothing that sounds like a title (the story just begins): null.
Keep the narrator's wording in title case. Fix a misspelling only when the book makes the right word clear. Never invent a title the narrator didn't say, and judge each chapter by its own transcripts.

Answer with only a JSON object, nothing before or after it: {"titles": [{"chapter": its number, "title": a string or null}, one for every chapter, in order]}`;

/** The request in words: the book, then each chapter's number, current title and what was heard. */
export function titlesText(req: TitlesRequest): string {
	const lines = [`Book: ${req.book}${req.author ? ` by ${req.author}` : ''}`, `Chapters: ${req.chapters.length}`, ''];
	const said = (text: string) => (text ? JSON.stringify(text) : '(nothing)');
	for (const [index, chapter] of req.chapters.entries())
		lines.push(`Chapter ${index + 1}. Now "${chapter.now}". Before: ${said(chapter.before)}. Heard: ${said(chapter.heard)}`);
	return lines.join('\n');
}

/**
 * One title per chapter, by the chapter numbers the model gave, trimmed; null where it gave none. Null for the lot
 * when it numbered fewer than half of them, which means it lost track.
 */
export function cleanTitles(titles: { chapter: number; title: string | null }[], count: number): (string | null)[] | null {
	const result: (string | null)[] = new Array(count).fill(null);
	const seen = new Set<number>();
	for (const { chapter, title } of titles) {
		if (chapter < 1 || chapter > count || seen.has(chapter)) continue;
		seen.add(chapter);
		const text = title?.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '';
		result[chapter - 1] = text || null;
	}
	return seen.size * 2 >= count ? result : null;
}

/** Whether any title says more than a number or the credits: otherwise the narrator reads no titles worth saving. */
export function named(titles: (string | null)[], book: string): boolean {
	return titles.some(
		(title) => title !== null && !isNumbered(title, book) && !/^(opening|end) credits$/i.test(title) && !/^chapter \d+$/i.test(title),
	);
}
