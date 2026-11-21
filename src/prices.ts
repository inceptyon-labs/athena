import type { PickOutcome } from './pick';

/** Dollars per million tokens: input, output, 5-minute cache write, cache read. */
interface Price {
	input: number;
	output: number;
	write: number;
	read: number;
}

// Anthropic's list prices in November 2026, and TypeSafe's for Jev (output is free).
const PRICES: Record<string, Price> = {
	'claude-haiku-5-5': { input: 0.1, output: 0.5, write: 0.125, read: 0.01 },
	'claude-sonnet-5-5': { input: 2, output: 10, write: 2.5, read: 0.1 },
	'claude-opus-5-5': { input: 4, output: 20, write: 5, read: 0.2 },
	'claude-fable-5-2': { input: 8, output: 40, write: 10, read: 0.2 },
	jev: { input: 0.042, output: 0, write: 0, read: 0 },
};

/** Haiku 5.5 costs five times as much for a prompt over 100K tokens: a library of a few thousand titles. */
const HAIKU_LONG: Price = { input: 0.5, output: 2.5, write: 0.625, read: 0.05 };

/** What one answer cost in dollars, or null for a model without a known price. */
export function cost(by: string, usage: PickOutcome['usage']): number | null {
	const read = usage.cache_read_input_tokens ?? 0;
	const write = usage.cache_creation_input_tokens ?? 0;
	let price = PRICES[by];
	if (!price) return null;
	if (by === 'claude-haiku-5-5' && usage.input_tokens + read + write > 100_000) price = HAIKU_LONG;
	return (
		(usage.input_tokens * price.input + usage.output_tokens * price.output + write * price.write + read * price.read) /
		1_000_000
	);
}

export const MODELS = [
	{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'about a quarter of a cent a request' },
	{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'about 20 times Haiku' },
	{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'about 40 times Haiku' },
];
