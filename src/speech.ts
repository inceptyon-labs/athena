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
	/** What was said in each clip, in order, and the credits it cost when the service says (ElevenLabs does). */
	transcribe(clips: Clip[], signal?: AbortSignal): Promise<Transcripts>;
}

export type Transcripts = { texts: string[]; credits: number | null };

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
	/** One clip's text and its credits, from the `character-cost` header ElevenLabs sends with each answer. */
	const one = async (clip: Clip, signal?: AbortSignal): Promise<{ text: string; credits: number | null }> => {
		if (clip.audio.length === 0) return { text: '', credits: 0 };
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
			if (response.ok) {
				const cost = response.headers.get('character-cost');
				const credits = cost !== null && /^\d+(\.\d+)?$/.test(cost.trim()) ? Number(cost) : null;
				return { text: ((await response.json()) as { text?: string }).text?.trim() ?? '', credits };
			}
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
			// Null once any answer leaves out its cost: then the total isn't known.
			let credits: number | null = 0;
			// The first request that fails stops the others.
			const failed = new AbortController();
			const signal = stop ? AbortSignal.any([stop, failed.signal]) : failed.signal;
			let next = 0;
			const worker = async () => {
				while (next < clips.length && !signal.aborted) {
					const index = next++;
					const answer = await one(clips[index] as Clip, signal);
					texts[index] = answer.text;
					credits = credits === null || answer.credits === null ? null : credits + answer.credits;
				}
			};
			await Promise.all(Array.from({ length: Math.min(SCRIBE_AT_ONCE, clips.length) }, worker)).catch((error: unknown) => {
				failed.abort();
				throw error;
			});
			if (stop?.aborted) throw new SpeechError('Stopped.');
			return { texts, credits };
		},
	};
}

/** The ElevenLabs plan the key belongs to: credits used and allowed this period, and when they renew. */
export type ElevenLabsAccount = {
	plan: string;
	used: number;
	limit: number;
	/** When the credits renew, in milliseconds. */
	renews: number | null;
	/** Credits speech to text used this period, all of it Athena's unless the key is used elsewhere. */
	speech: number | null;
};

/**
 * The key's plan and credits, from ElevenLabs' subscription and usage endpoints. Needs the key's "User: read"
 * permission; without it, throws why.
 */
export async function elevenLabsAccount(key: string, fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<ElevenLabsAccount> {
	const get = (path: string) =>
		fetcher(`https://api.elevenlabs.io${path}`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(8000) });
	let response: Response;
	try {
		response = await get('/v1/user/subscription');
	} catch {
		throw new SpeechError("ElevenLabs didn't answer.");
	}
	if (response.status === 401 || response.status === 403) {
		const body = (await response.json().catch(() => ({}))) as { detail?: { code?: string; message?: string } };
		if (/permission/i.test(body.detail?.message ?? ''))
			throw new SpeechError('The ElevenLabs key can’t read the account: give it the User read permission to see credits here.');
		throw new SpeechError('ElevenLabs turned the API key down.');
	}
	if (!response.ok) throw new SpeechError(`ElevenLabs answered ${response.status}.`);
	const sub = (await response.json()) as {
		tier?: string;
		character_count?: number;
		character_limit?: number;
		next_character_count_reset_unix?: number;
		character_refresh_period?: string;
		billing_period?: string;
	};
	const renews = sub.next_character_count_reset_unix ? sub.next_character_count_reset_unix * 1000 : null;
	// This period's speech to text, from the usage endpoint, counted from one credit period before the renewal.
	let speech: number | null = null;
	if (renews) {
		// The endpoint counts whole UTC days, so from the start of the period's first day to the end of today.
		const day = (at: number) => {
			const date = new Date(at);
			return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
		};
		const start = day(monthsBefore(renews, PERIOD_MONTHS[sub.character_refresh_period ?? sub.billing_period ?? ''] ?? 1));
		const end = day(now()) + 86_399_000;
		try {
			const usage = await get(
				`/v1/usage/character-stats?${new URLSearchParams({ start_unix: String(start), end_unix: String(end), breakdown_type: 'product_type' })}`,
			);
			if (usage.ok) {
				const days = ((await usage.json()) as { usage?: Record<string, number[]> }).usage?.STT;
				if (days) speech = Math.round(days.reduce((sum, day) => sum + day, 0));
			}
		} catch {}
	}
	return {
		plan: sub.tier ?? 'unknown',
		used: sub.character_count ?? 0,
		limit: sub.character_limit ?? 0,
		renews,
		speech,
	};
}

/**
 * How many months a credit period lasts, by ElevenLabs' name for it (elevenlabs.io/docs/api-reference/user/subscription/get).
 * Monthly when it names none of these.
 */
const PERIOD_MONTHS: Record<string, number> = { monthly_period: 1, '3_month_period': 3, '6_month_period': 6, annual_period: 12 };

/** The same moment `months` calendar months earlier, in UTC, on the month's last day when it has fewer days. */
export function monthsBefore(at: number, months: number): number {
	const date = new Date(at);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth() - months;
	const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return Date.UTC(year, month, Math.min(date.getUTCDate(), last), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
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
			if (heard.length === 0) return { texts: clips.map(() => ''), credits: null };
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
				return { texts: clips.map((clip) => texts[heard.indexOf(clip)] ?? ''), credits: null };
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	};
}
