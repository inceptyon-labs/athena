import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Clip, ClipFormat } from './clips';

/** Speech to text for Titles from the audio: ElevenLabs Scribe, or whisper.cpp in the speech image. */
export interface Speech {
	id: 'elevenlabs' | 'whisper';
	/** What the run log names. */
	name: string;
	/** Dollars per hour of audio. */
	perHour: number;
	format: ClipFormat;
	/** What was said in each clip, in order. */
	transcribe(clips: Clip[], signal?: AbortSignal): Promise<string[]>;
}

/**
 * ElevenLabs' batch model. Every Scribe model costs $0.20 an hour of audio, billed by the second with no minimum, as
 * of November 2026 (elevenlabs.io/pricing/api); keyterms would add to that, so none are sent.
 */
export const SCRIBE_MODEL = 'scribe_v3';
const SCRIBE_PER_HOUR = 0.2;
/** Requests at once: under every plan's limit (Free allows 8). */
const SCRIBE_AT_ONCE = 4;

export class SpeechError extends Error {}

export function elevenLabs(key: string, options: { model?: string; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): Speech {
	const fetcher = options.fetcher ?? fetch;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	const model = options.model ?? SCRIBE_MODEL;
	const one = async (clip: Clip, signal?: AbortSignal): Promise<string> => {
		if (clip.audio.length === 0) return '';
		for (let attempt = 0; ; attempt++) {
			const form = new FormData();
			form.append('model_id', model);
			form.append('tag_audio_events', 'false');
			form.append('file', new Blob([clip.audio], { type: 'audio/mpeg' }), `chapter-${clip.chapter + 1}.mp3`);
			let response: Response;
			try {
				response = await fetcher('https://api.elevenlabs.io/v1/speech-to-text', {
					method: 'POST',
					headers: { 'xi-api-key': key },
					body: form,
					signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
				});
			} catch (error) {
				if (signal?.aborted) throw new SpeechError('Stopped.');
				if (attempt < 2) continue;
				throw new SpeechError(`Athena couldn't reach ElevenLabs: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (response.ok) return ((await response.json()) as { text?: string }).text?.trim() ?? '';
			if ((response.status === 429 || response.status >= 500) && attempt < 3) {
				await sleep(2000 * (attempt + 1));
				continue;
			}
			if (response.status === 401 || response.status === 403) throw new SpeechError('ElevenLabs turned the API key down.');
			let detail = '';
			try {
				const body = (await response.json()) as { detail?: { message?: string } | string };
				detail = typeof body.detail === 'string' ? body.detail : (body.detail?.message ?? '');
			} catch {}
			throw new SpeechError(`ElevenLabs answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`);
		}
	};
	return {
		id: 'elevenlabs',
		name: 'ElevenLabs Scribe',
		perHour: SCRIBE_PER_HOUR,
		format: 'mp3',
		async transcribe(clips, stop) {
			const texts: string[] = new Array(clips.length);
			// The first request that fails stops the others.
			const failed = new AbortController();
			const signal = stop ? AbortSignal.any([stop, failed.signal]) : failed.signal;
			let next = 0;
			const worker = async () => {
				while (next < clips.length && !signal.aborted) {
					const index = next++;
					texts[index] = await one(clips[index] as Clip, signal);
				}
			};
			await Promise.all(Array.from({ length: Math.min(SCRIBE_AT_ONCE, clips.length) }, worker)).catch((error: unknown) => {
				failed.abort();
				throw error;
			});
			if (stop?.aborted) throw new SpeechError('Stopped.');
			return texts;
		},
	};
}

/** Where the speech image keeps its Whisper model, chosen when it's built. */
const MODELS = '/models';

/** The speech image's Whisper model, or null in an image without one. */
export function whisperModel(): string | null {
	if (!Bun.which('whisper-cli') || !Bun.which('ffmpeg')) return null;
	try {
		const file = readdirSync(MODELS)
			.filter((each) => /^ggml-.+\.bin$/.test(each))
			.sort()[0];
		return file ? join(MODELS, file) : null;
	} catch {
		return null;
	}
}

/** A model's name as people know it, such as `base.en`. */
export const whisperName = (path: string) => basename(path).replace(/^ggml-/, '').replace(/\.bin$/, '');

/**
 * whisper.cpp on this machine: free, and as quick as its CPU. Reads every clip in one go, loading the model once. `cli`
 * is where whisper-cli is, when it isn't on the PATH.
 */
export function whisper(model: string, options: { threads?: number; cli?: string } = {}): Speech {
	const threads = options.threads ?? Math.max(1, Math.min(8, cpus().length - 1));
	return {
		id: 'whisper',
		name: `Whisper ${whisperName(model)}`,
		perHour: 0,
		format: 'wav',
		async transcribe(clips, signal) {
			const heard = clips.filter((clip) => clip.audio.length > 0);
			if (heard.length === 0) return clips.map(() => '');
			const dir = await mkdtemp(join(tmpdir(), 'athena-whisper-'));
			try {
				// Named by place in the list: a chapter's lead-in and opening are two clips.
				const files = await Promise.all(
					heard.map(async (clip, index) => {
						const file = join(dir, `${String(index).padStart(5, '0')}.wav`);
						await writeFile(file, clip.audio);
						return file;
					}),
				);
				const english = whisperName(model).includes('.en');
				const child = Bun.spawn(
					[options.cli ?? 'whisper-cli', '-m', model, '-t', String(threads), '-np', '-nt', '-otxt', ...(english ? [] : ['-l', 'auto']), ...files.flatMap((file) => ['-f', file])],
					{ stdout: 'ignore', stderr: 'pipe', signal },
				);
				const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
				if (signal?.aborted) throw new SpeechError('Stopped.');
				// A clip Whisper couldn't read has no transcript and counts as silence; only none at all is a failure.
				const texts = await Promise.all(
					files.map((file) =>
						readFile(`${file}.txt`, 'utf8').then(
							// Whisper's notes on what it heard instead of words, such as "[BLANK_AUDIO]" and "[ Silence ]".
							(text) => text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(),
							() => null,
						),
					),
				);
				if (code !== 0 && texts.every((text) => text === null))
					throw new SpeechError(`Whisper failed: ${err.trim().split('\n').at(-1)?.slice(0, 200) ?? `exit ${code}`}`);
				return clips.map((clip) => texts[heard.indexOf(clip)] ?? '');
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	};
}
