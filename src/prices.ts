import type { PickOutcome } from './pick';

/** Dollars per million tokens: input, output, 5-minute cache write, cache read. */
interface Price {
	input: number;
	output: number;
	write: number;
	read: number;
}

// List prices in November 2026, standard tier, at the request sizes Athena sends. The other providers' cache writes cost
// the same as input. Where a price rises on a date already announced (Gemini 4 Carbon on December 1, 2026), the higher
// one; DeepSeek's at peak hours, which are American evenings.
const PRICES: Record<string, Price> = {
	'claude-haiku-5-5': { input: 0.1, output: 0.5, write: 0.125, read: 0.01 },
	'claude-sonnet-5-5': { input: 2, output: 10, write: 2.5, read: 0.1 },
	'claude-opus-5-5': { input: 4, output: 20, write: 5, read: 0.2 },
	'claude-fable-5-2': { input: 8, output: 40, write: 10, read: 0.2 },
	'gpt-6-luna': { input: 0.1, output: 0.5, write: 0.1, read: 0.01 },
	'gpt-6.2-sol': { input: 2, output: 10, write: 2, read: 0.1 },
	'gpt-6.2-astra': { input: 8, output: 40, write: 8, read: 0.4 },
	'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, write: 0.3, read: 0.03 },
	'gemini-4-hydrogen': { input: 1.5, output: 7.5, write: 1.5, read: 0.075 },
	'gemini-4-carbon': { input: 4, output: 20, write: 4, read: 0.2 },
	'grok-4.3': { input: 1.25, output: 2.5, write: 1.25, read: 0.2 },
	'grok-4.5': { input: 2, output: 6, write: 2, read: 0.3 },
	'grok-4.7': { input: 2, output: 6, write: 2, read: 0.5 },
	'deepseek-flash': { input: 0.3, output: 1.2, write: 0.3, read: 0.006 },
	'deepseek-v4-pro': { input: 1.32, output: 3.96, write: 1.32, read: 0.044 },
	jev: { input: 0.042, output: 0, write: 0, read: 0 },
};

/** Haiku 5.5 costs five times as much for a prompt over 100K tokens: a library of a few thousand titles. */
const HAIKU_LONG: Price = { input: 0.5, output: 2.5, write: 0.625, read: 0.05 };

/** What one answer cost in dollars, or null for a model without a known price. */
export function cost(by: string, usage: PickOutcome['usage']): number | null {
	const read = usage.cache_read_input_tokens ?? 0;
	const write = usage.cache_creation_input_tokens ?? 0;
	// A model on the owner's own machine costs nothing per request.
	if (by.startsWith('local:')) return 0;
	let price = PRICES[by];
	if (!price) return null;
	if (by === 'claude-haiku-5-5' && usage.input_tokens + read + write > 100_000) price = HAIKU_LONG;
	return (
		(usage.input_tokens * price.input + usage.output_tokens * price.output + write * price.write + read * price.read) /
		1_000_000
	);
}

/** A model's list price per million tokens, for Settings. */
export function listPrice(model: string): { input: number; output: number } | null {
	const price = PRICES[model];
	return price ? { input: price.input, output: price.output } : null;
}

/** About what an answer writes: a reason under each of up to nine picks, or six suggestions. */
const ANSWER = 400;

/** A Describe It's two prompts when the log has none yet: a 600-title library, and the same with Seerr's recent list. */
export const TYPICAL = { picks: 25_000, suggestions: 29_000 };

/**
 * What one Describe It costs before caching: Ithaca's two requests, picks and suggestions, each carrying the library,
 * sent at once so neither reads the other's cache. With Jev, the picks request goes to Jev instead.
 */
export function perDescribeIt(model: string, prompts: { picks: number; suggestions: number }, jev: boolean): number | null {
	const suggestions = cost(model, { input_tokens: prompts.suggestions, output_tokens: ANSWER });
	const picks = jev
		? cost('jev', { input_tokens: prompts.picks, output_tokens: 0 })
		: cost(model, { input_tokens: prompts.picks, output_tokens: ANSWER });
	return suggestions === null || picks === null ? null : picks + suggestions;
}
