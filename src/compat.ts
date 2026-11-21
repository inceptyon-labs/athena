import { z } from 'zod';
import {
	type AI,
	cleanMinimums,
	cleanPicks,
	cleanSuggestions,
	discoverText,
	libraryText,
	PickError,
	type PickOutcome,
	PickResult,
	requestText,
	SYSTEM,
} from './pick';
import type { Provider } from './providers';

/**
 * Every provider but Anthropic, through the OpenAI-style Chat Completions API they all offer: OpenAI, Gemini, Grok,
 * DeepSeek, and local servers such as Ollama and LM Studio. Each caches a repeated prompt start by itself, so the
 * system text, the library and the recent list go first, in the same order as Claude's cached blocks.
 */

/** The answer's shape in words, for JSON mode and for local models that don't follow a schema. */
export const JSON_SHAPE = `Answer with only a JSON object in this shape, nothing before or after it:
{"minimums": {"critics": number or null, "audience": number or null, "imdb": number or null}, "picks": [{"id": "id from the library list", "reason": "..."}], "suggestions": [{"title": "...", "year": number or null, "discoverId": "id from the recent list, or null", "reason": "..."}]}`;

const { $schema: _, ...SCHEMA } = z.toJSONSchema(PickResult);

interface Usage {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number | null } | null;
	/** DeepSeek's name for cached prompt tokens. */
	prompt_cache_hit_tokens?: number;
}

interface Completion {
	choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
	usage?: Usage;
}

export interface CompatOptions {
	/** Null for a local server that takes none. */
	key: string | null;
	/** The API's base, such as https://api.openai.com/v1. */
	base: string;
	fetcher?: typeof fetch;
}

/** Their prompt tokens include the cached ones; Claude's don't, and the log and prices follow Claude's. */
function tokens(usage: Usage | undefined): PickOutcome['usage'] {
	const prompt = usage?.prompt_tokens ?? 0;
	const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
	return {
		input_tokens: Math.max(0, prompt - cached),
		output_tokens: usage?.completion_tokens ?? 0,
		cache_read_input_tokens: cached,
		cache_creation_input_tokens: 0,
	};
}

/** The JSON in an answer, past any thinking a local model wrote first or a code fence around it. */
export function answerJSON(content: string): unknown {
	const text = content.replace(/<think>[\s\S]*?<\/think>/g, '');
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end < start) throw new Error('no JSON object');
	return JSON.parse(text.slice(start, end + 1));
}

function headers(key: string | null): Record<string, string> {
	return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

/** What went wrong, in words Ithaca can show. */
function failure(provider: Provider, status: number, body: string): string {
	const brand = provider.brand;
	if (status === 401 || status === 403) return `Athena's ${provider.name} API key was rejected.`;
	if (status === 429) return `${brand} is rate limiting Athena. Try again in a minute.`;
	if (status >= 500) return `${brand} is busy. Try again.`;
	let detail = body;
	try {
		detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
	} catch {}
	return `${brand} returned an error (${status}): ${detail.slice(0, 200)}`;
}

export function compat(provider: Provider, model: string, options: CompatOptions): AI {
	const fetcher = options.fetcher ?? fetch;
	const local = provider.id === 'local';
	const effort = provider.models.find((candidate) => candidate.id === model)?.effort;
	return {
		by: local ? `local:${model}` : model,
		async pick(req) {
			const discover = discoverText(req);
			const body = {
				model,
				messages: [
					{ role: 'system', content: `${SYSTEM}\n\n${JSON_SHAPE}` },
					{ role: 'user', content: [libraryText(req), discover, requestText(req)].filter(Boolean).join('\n\n') },
				],
				response_format:
					provider.json === 'object'
						? { type: 'json_object' }
						: { type: 'json_schema', json_schema: { name: 'picks', strict: true, schema: SCHEMA } },
				// Thinking counts toward the cap with most of them.
				...(provider.cap ? { [provider.cap]: 8192 } : {}),
				...(effort ? { reasoning_effort: effort } : {}),
			};
			let response: Response | null = null;
			// One retry, as with Claude: a viewer is waiting on the other end.
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					response = await fetcher(`${options.base}/chat/completions`, {
						method: 'POST',
						headers: headers(options.key),
						body: JSON.stringify(body),
						// A local model on modest hardware takes a while to read a whole library.
						signal: AbortSignal.timeout(local ? 120_000 : 45_000),
					});
				} catch (error) {
					if (attempt === 0 && !local && !(error instanceof DOMException && error.name === 'TimeoutError')) continue;
					throw new PickError(
						local ? "Athena couldn't reach its local model." : `Athena couldn't reach ${provider.brand}. Try again.`,
					);
				}
				if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
				break;
			}
			if (!response) throw new PickError(`Athena couldn't reach ${provider.brand}. Try again.`);
			if (!response.ok) throw new PickError(failure(provider, response.status, await response.text()));
			const completion = (await response.json()) as Completion;
			const choice = completion.choices?.[0];
			if (choice?.message?.refusal) throw new PickError(`${provider.brand} declined that request.`);
			if (choice?.finish_reason === 'length') throw new PickError(`${provider.brand}'s answer was cut off.`);
			let parsed: ReturnType<typeof PickResult.safeParse>;
			try {
				parsed = PickResult.safeParse(answerJSON(choice?.message?.content ?? ''));
			} catch {
				throw new PickError(`${provider.brand}'s answer wasn't the JSON Athena asked for.`);
			}
			if (!parsed.success) throw new PickError(`${provider.brand}'s answer wasn't the JSON Athena asked for.`);
			return {
				picks: cleanPicks(parsed.data.picks, req),
				suggestions: cleanSuggestions(parsed.data.suggestions, req),
				minimums: cleanMinimums(parsed.data.minimums),
				usage: tokens(completion.usage),
			};
		},
	};
}

/**
 * The models a key or a local server offers, for Settings' Test button, or "rejected" when the key isn't taken.
 * Throws when the server can't be reached.
 */
export async function listModels(base: string, key: string | null, fetcher: typeof fetch = fetch): Promise<string[] | 'rejected'> {
	const response = await fetcher(`${base}/models`, { headers: headers(key), signal: AbortSignal.timeout(8000) });
	// Gemini answers a bad key with 400.
	if (response.status === 400 || response.status === 401 || response.status === 403) return 'rejected';
	if (!response.ok) throw new Error(`answered ${response.status}`);
	const body = (await response.json()) as { data?: { id?: string }[] };
	return (body.data ?? []).map((entry) => (entry.id ?? '').replace(/^models\//, '')).filter(Boolean);
}
