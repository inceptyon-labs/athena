import { z } from 'zod';
import { isNumbered } from './chapters';

/**
 * Titles from the audio: what the narrator says at the start of each chapter, turned into the book's chapter titles by
 * the AI model the owner chose. Claude can't take audio, so speech to text comes first (`src/speech.ts`).
 */

export type TitlesRequest = {
	book: string;
	author: string | null;
	/** Each chapter's current title and what was heard in its first seconds, in order. */
	chapters: { now: string; heard: string }[];
};

export const TitlesResult = z.object({ titles: z.array(z.string().nullable()) });

export const TITLES_SYSTEM = `You name an audiobook's chapters from what the narrator says at the start of each one.

You get the book's title and author, and for each chapter in order, its current title (only a number) and a transcript of its first seconds made by speech to text. Transcripts may misspell names and may start with a word or two of the chapter before.

For each chapter, give its title as the book's table of contents would list it, from the narrator's words:
- A chapter read with a number and a name: "Chapter 12: The Long Night". Write the number in digits.
- A name alone, or a part, prologue or epilogue: "The Long Night", "Part Two: The Sea", "Prologue", "Epilogue".
- Only a number read out: "Chapter 12".
- Opening credits ("This is Audible", the title, author and narrator read out): "Opening Credits". Closing credits: "End Credits".
- Nothing that sounds like a title (the story just begins): null.
Keep the narrator's wording in title case. Fix a misspelling only when the book makes the right word clear. Never invent a title the narrator didn't say.

Answer with only a JSON object, nothing before or after it: {"titles": [one string or null per chapter, in order]}`;

/** The request in words: the book, then each chapter's number, current title and what was heard. */
export function titlesText(req: TitlesRequest): string {
	const lines = [`Book: ${req.book}${req.author ? ` by ${req.author}` : ''}`, `Chapters: ${req.chapters.length}`, ''];
	for (const [index, chapter] of req.chapters.entries())
		lines.push(`${index + 1}. Now "${chapter.now}". Heard: ${chapter.heard ? JSON.stringify(chapter.heard) : '(nothing)'}`);
	return lines.join('\n');
}

/** One title per chapter, trimmed, or null where the model gave none; null for the lot when it didn't give one each. */
export function cleanTitles(titles: (string | null)[], count: number): (string | null)[] | null {
	if (titles.length !== count) return null;
	return titles.map((title) => {
		const text = title?.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '';
		return text ? text : null;
	});
}

/** Whether any title says more than a number or the credits: otherwise the narrator reads no titles worth saving. */
export function named(titles: (string | null)[], book: string): boolean {
	return titles.some(
		(title) => title !== null && !isNumbered(title, book) && !/^(opening|end) credits$/i.test(title) && !/^chapter \d+$/i.test(title),
	);
}
