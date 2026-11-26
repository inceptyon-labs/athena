import type { AbsBook, AbsChapter, AbsTrack, Audiobookshelf } from './abs';

/**
 * The opening seconds of each chapter, cut with ffmpeg from the book's files over Audiobookshelf's API. ffmpeg seeks
 * with range requests, so only a little of each file is read. Only the speech image has ffmpeg.
 */

/** A chapter's opening, mono at 16 kHz: MP3 to send to ElevenLabs, WAV for Whisper. */
export type Clip = { chapter: number; audio: Uint8Array<ArrayBuffer>; seconds: number };

export type ClipFormat = 'mp3' | 'wav';

/** How much of each chapter to read: long enough for "Part Two. Chapter Eleven. The Long Night." after a pause. */
export const CLIP_SECONDS = 20;

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

/** The first `seconds` of each chapter, cut a few at a time. Throws on the first that fails. */
export async function chapterClips(
	abs: Audiobookshelf,
	book: Pick<AbsBook, 'tracks'>,
	chapters: AbsChapter[],
	options: { format: ClipFormat; seconds?: number; signal?: AbortSignal; cutter?: Cutter },
): Promise<Clip[]> {
	const cut = options.cutter ?? ffmpeg;
	const want = options.seconds ?? CLIP_SECONDS;
	const encode =
		options.format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3'] : ['-c:a', 'pcm_s16le', '-f', 'wav'];
	const clips: Clip[] = new Array(chapters.length);
	// The first cut that fails stops the others.
	const failed = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, failed.signal]) : failed.signal;
	let next = 0;
	const worker = async () => {
		while (next < chapters.length) {
			if (signal.aborted) throw new Error('Stopped.');
			const index = next++;
			const chapter = chapters[index] as AbsChapter;
			const pieces = locate(book, chapter.start, Math.max(0.5, Math.min(want, chapter.end - chapter.start)));
			if (book.tracks.length === 0) throw new Error('Audiobookshelf lists no audio files for this book.');
			// A chapter of no length, such as an empty last one, has nothing to hear.
			if (pieces.length === 0) {
				clips[index] = { chapter: index, audio: new Uint8Array(), seconds: 0 };
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
			const audio = await cut([...inputs, ...join, '-ac', '1', '-ar', '16000', ...encode, 'pipe:1'], signal);
			if (audio.length === 0) throw new Error(`ffmpeg cut nothing from chapter ${index + 1}.`);
			clips[index] = { chapter: index, audio, seconds: pieces.reduce((sum, piece) => sum + piece.seconds, 0) };
		}
	};
	await Promise.all(Array.from({ length: Math.min(AT_ONCE, chapters.length) }, worker)).catch((error: unknown) => {
		failed.abort();
		throw error;
	});
	return clips;
}
