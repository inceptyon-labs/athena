import type { AbsBook, AbsChapter, AbsTrack, Audiobookshelf } from './abs';

/**
 * The opening seconds of each chapter, cut with ffmpeg from the book's files over Audiobookshelf's API. ffmpeg seeks
 * with range requests, so only a little of each file is read. Only the speech image has ffmpeg.
 */

/**
 * A piece of a chapter, mono at 16 kHz: MP3 to send to ElevenLabs, WAV for Whisper. `lead` is the few seconds before
 * the chapter's mark; otherwise it's the chapter's opening from the mark. Empty, with why, when that part of the book
 * couldn't be cut, such as a damaged file.
 */
export type Clip = { chapter: number; lead: boolean; audio: Uint8Array<ArrayBuffer>; seconds: number; error?: string };

export type ClipFormat = 'mp3' | 'wav';

/** How much of each chapter to read: long enough for "Part Two. Chapter Eleven. The Long Night." after a pause. */
export const CLIP_SECONDS = 20;
/**
 * How much before each chapter's mark is also read, on its own: a mark a moment late (common where Audible's marks
 * don't line up) would otherwise cut off the chapter's number as it's read. On its own, since Whisper stops at the
 * pause between chapters and would miss the opening.
 */
export const LEAD_IN = 3;

/** The seconds read for a chapter: its lead-in, then its first `CLIP_SECONDS` or all of it. */
export const clipLength = (chapter: AbsChapter) => Math.min(LEAD_IN, chapter.start) + opening(chapter);

const opening = (chapter: AbsChapter) => Math.max(0.5, Math.min(CLIP_SECONDS, chapter.end - chapter.start));

/** How many ffmpegs run at once. */
const AT_ONCE = 3;

/** Runs ffmpeg with these arguments and resolves to what it wrote. */
export type Cutter = (args: string[], signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;

export const hasFfmpeg = () => Bun.which('ffmpeg') !== null;

/** How long one cut may take, however Audiobookshelf answers. */
const CUT_DEADLINE = 120_000;

/** ffmpeg, which says only what went wrong: its arguments hold the API key, so they're never shown. */
export const ffmpeg: Cutter = async (args, signal) => {
	const deadline = AbortSignal.timeout(CUT_DEADLINE);
	const child = Bun.spawn(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
	});
	const [out, err, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
	if (deadline.aborted) throw new Error("Audiobookshelf didn't send the audio in time.");
	if (code !== 0) throw new Error(`ffmpeg couldn't cut the audio: ${err.trim().split('\n').at(-1)?.slice(0, 200) ?? `exit ${code}`}`);
	return out;
};

/** The pieces of the book's files that make up `seconds` from `at`: one, unless the stretch runs into the next file. */
export function locate(book: Pick<AbsBook, 'tracks'>, at: number, seconds: number) {
	const pieces: { track: AbsTrack; offset: number; seconds: number }[] = [];
	let from = at;
	let left = seconds;
	for (const track of book.tracks) {
		const end = track.startOffset + track.duration;
		if (left <= 0.05) break;
		if (end <= from + 0.001) continue;
		const offset = Math.max(0, from - track.startOffset);
		const take = Math.min(left, track.duration - offset);
		if (take <= 0) continue;
		pieces.push({ track, offset, seconds: take });
		from = end;
		left -= take;
	}
	return pieces;
}

/**
 * Each chapter's lead-in and opening, cut a few at a time, in chapter order. A part that can't be cut is left empty
 * with why; only when no opening can be does it throw.
 */
export async function chapterClips(
	abs: Audiobookshelf,
	book: Pick<AbsBook, 'tracks'>,
	chapters: AbsChapter[],
	options: { format: ClipFormat; signal?: AbortSignal; cutter?: Cutter },
): Promise<Clip[]> {
	if (book.tracks.length === 0) throw new Error('Audiobookshelf lists no audio files for this book.');
	const cut = options.cutter ?? ffmpeg;
	const encode =
		options.format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3'] : ['-c:a', 'pcm_s16le', '-f', 'wav'];
	const signal = options.signal;
	const parts = chapters.flatMap((chapter, index) => {
		const lead = Math.min(LEAD_IN, chapter.start);
		return [
			...(lead >= 0.5 ? [{ chapter: index, lead: true, from: chapter.start - lead, seconds: lead }] : []),
			{ chapter: index, lead: false, from: chapter.start, seconds: opening(chapter) },
		];
	});
	const clips: Clip[] = new Array(parts.length);
	let next = 0;
	const worker = async () => {
		while (next < parts.length) {
			if (signal?.aborted) throw new Error('Stopped.');
			const at = next++;
			const part = parts[at] as (typeof parts)[number];
			const pieces = locate(book, part.from, part.seconds);
			const empty = { chapter: part.chapter, lead: part.lead, audio: new Uint8Array(), seconds: 0 };
			// A chapter of no length, such as an empty last one, has nothing to hear.
			if (pieces.length === 0) {
				clips[at] = empty;
				continue;
			}
			// Each piece is its own input, read by range requests, giving up on a read that stalls for 30 s.
			const inputs = pieces.flatMap((piece) => {
				const input = abs.trackInput(piece.track);
				return ['-rw_timeout', '30000000', '-headers', input.headers, '-ss', piece.offset.toFixed(3), '-t', piece.seconds.toFixed(3), '-i', input.url];
			});
			const join =
				pieces.length === 1
					? ['-vn']
					: ['-filter_complex', `${pieces.map((_, n) => `[${n}:a]`).join('')}concat=n=${pieces.length}:v=0:a=1[a]`, '-map', '[a]'];
			try {
				const audio = await cut([...inputs, ...join, '-ac', '1', '-ar', '16000', ...encode, 'pipe:1'], signal);
				if (audio.length === 0) throw new Error('ffmpeg cut nothing.');
				clips[at] = { ...empty, audio, seconds: pieces.reduce((sum, piece) => sum + piece.seconds, 0) };
			} catch (error) {
				if (signal?.aborted) throw error;
				clips[at] = { ...empty, error: error instanceof Error ? error.message : String(error) };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(AT_ONCE, parts.length) }, worker));
	const openings = clips.filter((clip) => !clip.lead && (clip.error || clip.audio.length > 0));
	if (openings.length > 0 && openings.every((clip) => clip.error)) throw new Error(openings[0]?.error ?? "ffmpeg couldn't cut the audio.");
	return clips;
}
