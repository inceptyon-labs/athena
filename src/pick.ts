import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** Review scores: Rotten Tomatoes critics and audience in percent, IMDb and TMDB out of 10. */
const Scores = z.object({
	critics: z.number().int().min(0).max(100).optional(),
	audience: z.number().int().min(0).max(100).optional(),
	imdb: z.number().min(0).max(10).optional(),
	tmdb: z.number().min(0).max(10).optional(),
});
type Scores = z.infer<typeof Scores>;

const Title = z.object({
	id: z.string().min(1).max(32),
	title: z.string().min(1).max(300),
	year: z.number().int().optional(),
	genres: z.array(z.string().max(60)).max(12).optional(),
	/** A movie's running time, or a show's typical episode. */
	minutes: z.number().int().positive().optional(),
	contentRating: z.string().max(20).optional(),
	scores: Scores.optional(),
	seen: z.boolean().optional(),
	rating: z.enum(['loved', 'liked', 'disliked']).optional(),
});

/** A popular recent title the household does not have, from Seerr. */
const Outside = z.object({
	id: z.string().min(1).max(32),
	title: z.string().min(1).max(300),
	year: z.number().int().optional(),
	genres: z.array(z.string().max(60)).max(12).optional(),
	overview: z.string().max(400).optional(),
	tmdb: z.number().min(0).max(10).optional(),
});

const Names = z.array(z.string().max(300)).max(30).optional();

/** What Ithaca sends: the request, and the titles that already fit its filters. */
export const PickRequest = z
	.object({
		request: z.string().trim().min(1).max(500),
		kind: z.enum(['movie', 'show']),
		/** 0 asks for suggestions only. */
		count: z.number().int().min(0).max(12).default(9),
		/** Empty when nothing in the library fits and only suggestions are wanted. */
		titles: z.array(Title).max(5000),
		taste: z.object({ loved: Names, liked: Names, disliked: Names, recent: Names }).optional(),
		/** Ids already on screen or queued: never picked again. */
		exclude: z.array(z.string().max(32)).max(5000).optional(),
		/** How many titles outside the library to suggest requesting. */
		suggest: z.number().int().min(0).max(12).default(0),
		discover: z.array(Outside).max(100).optional(),
		/** The screen's filters, which the titles already meet and suggestions must. */
		maxMinutes: z.number().int().positive().optional(),
		genre: z.string().max(60).optional(),
	})
	.refine((req) => (req.count > 0 && req.titles.length > 0) || req.suggest > 0, {
		message: 'Send titles to pick from, or ask for suggestions.',
		path: ['titles'],
	});
export type PickRequest = z.infer<typeof PickRequest>;

export const PickResult = z.object({
	minimums: z.object({
		critics: z.number().nullable(),
		audience: z.number().nullable(),
		imdb: z.number().nullable(),
	}),
	picks: z.array(z.object({ id: z.string(), reason: z.string() })),
	suggestions: z.array(
		z.object({
			title: z.string(),
			year: z.number().int().nullable(),
			discoverId: z.string().nullable(),
			reason: z.string(),
		}),
	),
});
type PickResult = z.infer<typeof PickResult>;
export type Pick = PickResult['picks'][number];
export type Suggestion = PickResult['suggestions'][number];
export type Minimums = PickResult['minimums'];

export const SYSTEM = `You help a household choose what to watch. You get their own library as a list with ids, sometimes what this viewer loved, liked, disliked or watched lately, sometimes popular recent titles they do not have, and a request in their own words.

First, minimums. When the request sets a minimum rating, record it: critics is the Rotten Tomatoes critics score (the Tomatometer) and audience is the Rotten Tomatoes audience score, both in percent; imdb is out of 10. "Rotten Tomatoes" or "RT" alone means critics, and a Rotten Tomatoes score out of 10 is ten times that in percent: "over 8 on Rotten Tomatoes" is a critics minimum of 80. Use null for each one the request does not set.

Picks are the titles from the library that best fit the request.
- Only use ids from the library list. Never pick anything that is not on it.
- What the request asks for is a requirement: mood, genre, length, era, rating, who is watching, what to avoid. The viewer's taste only decides between titles that fit equally well.
- Lengths are in minutes. For a TV show, the length is a typical episode.
- Judge a minimum rating by the scores on the list: a title listed below it never fits. A title without that score can still be picked when you are confident it meets it.
- Unless the request is narrow, make the picks different from each other.
- Best fit first. Return fewer picks than asked when fewer fit, and none when nothing does. Never fill the count with a title that misses part of the request.

Suggestions are titles the household does not have, for them to request. Give them only when asked for some.
- Real, released titles of the same kind as the library, each with its release year. Never one on the library list.
- They meet the request the same way, including the filters set on screen and any minimum rating, judged from what you know.
- When a title on the recent list fits, suggest it with its id as discoverId. Otherwise suggest from what you know, with discoverId null.
- Best fit first. Unless the request is narrow, make them different from each other.

Each reason is one sentence of at most 15 words on why the title fits this request. Be specific, give no spoilers and do not repeat the title.`;

const noun = (req: PickRequest) => (req.kind === 'movie' ? 'movies' : 'TV shows');

function scoresText(scores: Scores | undefined): string {
	if (!scores) return '';
	return [
		scores.critics !== undefined ? `RT critics ${scores.critics}%` : '',
		scores.audience !== undefined ? `RT audience ${scores.audience}%` : '',
		scores.imdb !== undefined ? `IMDb ${scores.imdb}` : '',
		scores.tmdb !== undefined ? `TMDB ${scores.tmdb}` : '',
	]
		.filter(Boolean)
		.join(', ');
}

function titleLine(title: PickRequest['titles'][number]): string {
	const name = title.year ? `${title.title} (${title.year})` : title.title;
	const history = [title.seen ? 'seen' : '', title.rating ?? ''].filter(Boolean).join(', ');
	return [
		title.id,
		name,
		(title.genres ?? []).join(', '),
		title.minutes ? `${title.minutes} min` : '',
		title.contentRating ?? '',
		scoresText(title.scores),
		history,
	].join(' | ');
}

/**
 * The library and the viewer's taste. It changes only when the filters or the
 * ratings do, so it is the cached part of the prompt.
 */
export function libraryText(req: PickRequest): string {
	const parts = req.titles.length
		? [
				`The household's ${noun(req)}, one per line: id | title (year) | genres | length | age rating | scores | this viewer's history`,
				req.titles.map(titleLine).join('\n'),
			]
		: [`Nothing in the household's ${noun(req)} fits the filters on screen.`];
	const taste = req.taste;
	const lines = [
		['Loved', taste?.loved],
		['Liked', taste?.liked],
		['Did not like', taste?.disliked],
		['Watched lately', taste?.recent],
	]
		.filter((entry): entry is [string, string[]] => (entry[1]?.length ?? 0) > 0)
		.map(([label, names]) => `${label}: ${names.join('; ')}`);
	if (lines.length) parts.push(`What this viewer thinks of what they have watched:\n${lines.join('\n')}`);
	return parts.join('\n\n');
}

/** Seerr's recent titles, cached after the library: the same list comes with every first request. */
export function discoverText(req: PickRequest): string | null {
	if (req.suggest === 0 || !req.discover?.length) return null;
	const lines = req.discover.map((title) =>
		[
			title.id,
			title.year ? `${title.title} (${title.year})` : title.title,
			(title.genres ?? []).join(', '),
			title.tmdb !== undefined ? `TMDB ${title.tmdb}` : '',
			title.overview ?? '',
		].join(' | '),
	);
	return `Popular recent ${noun(req)} the household does not have, one per line: id | title (year) | genres | score | about\n${lines.join('\n')}`;
}

export function requestText(req: PickRequest): string {
	const parts = [`Request: ${JSON.stringify(req.request)}`];
	const filters = [
		req.maxMinutes ? `under ${req.maxMinutes} minutes${req.kind === 'show' ? ' an episode' : ''}` : '',
		req.genre ? `genre ${req.genre}` : '',
	].filter(Boolean);
	if (filters.length) parts.push(`Filters set on screen: ${filters.join('; ')}.`);
	if (req.exclude?.length) parts.push(`Already suggested, leave these ids out: ${req.exclude.join(', ')}`);
	parts.push(req.count && req.titles.length ? `Pick up to ${req.count}.` : 'Pick none.');
	parts.push(
		req.suggest
			? `Suggest ${req.suggest} ${noun(req)} the household does not have, fewer only when fewer fit.`
			: 'Suggest none.',
	);
	return parts.join('\n');
}

/** The model's picks, keeping only ids from the list, each once, never excluded ones. */
export function cleanPicks(picks: Pick[], req: PickRequest): Pick[] {
	if (req.count === 0) return [];
	const known = new Set(req.titles.map((title) => title.id));
	const used = new Set(req.exclude ?? []);
	const result: Pick[] = [];
	for (const pick of picks) {
		const id = pick.id.trim();
		if (!known.has(id) || used.has(id)) continue;
		used.add(id);
		result.push({ id, reason: pick.reason.trim() });
		if (result.length === req.count) break;
	}
	return result;
}

/** Suggestions up to the number asked, each title once; a discoverId not on the list is dropped. */
export function cleanSuggestions(suggestions: Suggestion[], req: PickRequest): Suggestion[] {
	const listed = new Set((req.discover ?? []).map((title) => title.id));
	const used = new Set<string>();
	const result: Suggestion[] = [];
	for (const suggestion of suggestions) {
		if (result.length === req.suggest) break;
		const title = suggestion.title.trim();
		const key = `${title.toLowerCase()}|${suggestion.year ?? ''}`;
		if (!title || used.has(key)) continue;
		used.add(key);
		const discoverId = suggestion.discoverId?.trim() ?? '';
		result.push({
			title,
			year: suggestion.year,
			discoverId: listed.has(discoverId) ? discoverId : null,
			reason: suggestion.reason.trim(),
		});
	}
	return result;
}

/** Percent for Rotten Tomatoes, out of 10 for IMDb, whichever scale the model used. */
export function cleanMinimums(minimums: Minimums): Minimums {
	const percent = (value: number | null) => {
		if (value === null || !Number.isFinite(value) || value <= 0) return null;
		return Math.min(100, Math.round(value <= 10 ? value * 10 : value));
	};
	const imdb = minimums.imdb;
	return {
		critics: percent(minimums.critics),
		audience: percent(minimums.audience),
		imdb: imdb === null || !Number.isFinite(imdb) || imdb <= 0 ? null : Math.min(10, imdb > 10 ? imdb / 10 : imdb),
	};
}

export class PickError extends Error {
	constructor(
		message: string,
		readonly status: 502 | 503 = 502,
		/** Set when the model answered but the answer couldn't be used: it was paid for all the same. */
		readonly paid?: { by: string; usage: PickOutcome['usage'] },
	) {
		super(message);
	}
}

export interface PickOutcome {
	picks: Pick[];
	suggestions: Suggestion[];
	minimums: Minimums;
	/** Token counts for the log; Jev has no cache. */
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number | null;
		cache_creation_input_tokens?: number | null;
	};
}

/** The model that reads Describe It: Claude here, or another provider's through `src/compat.ts`. */
export interface AI {
	/** What the request log names as having answered: the model's id, or `local:<model>`. */
	by: string;
	pick(req: PickRequest): Promise<PickOutcome>;
}

export function claude(client: Anthropic, model: string): AI {
	return { by: model, pick: (req) => pick(client, model, req) };
}

export async function pick(client: Anthropic, model: string, req: PickRequest): Promise<PickOutcome> {
	const discover = discoverText(req);
	const response = await client.messages
		.parse({
			model,
			// Thinking counts toward the cap.
			max_tokens: 4096,
			system: SYSTEM,
			// Choosing from a list needs little thinking, and the viewer is waiting.
			output_config: { effort: 'low', format: zodOutputFormat(PickResult) },
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: libraryText(req), cache_control: { type: 'ephemeral' } },
						...(discover
							? [{ type: 'text' as const, text: discover, cache_control: { type: 'ephemeral' as const } }]
							: []),
						{ type: 'text', text: requestText(req) },
					],
				},
			],
		})
		.catch((error: unknown) => {
			throw new PickError(describe(error));
		});
	const paid = { by: model, usage: response.usage };
	if (response.stop_reason === 'refusal') throw new PickError('Claude declined that request.', 502, paid);
	const result = response.parsed_output;
	if (!result) throw new PickError(`Claude's answer was cut off (${response.stop_reason}).`, 502, paid);
	return {
		picks: cleanPicks(result.picks, req),
		suggestions: cleanSuggestions(result.suggestions, req),
		minimums: cleanMinimums(result.minimums),
		usage: response.usage,
	};
}

function describe(error: unknown): string {
	if (error instanceof Anthropic.APIError) {
		if (error.status === 401 || error.status === 403) return "Athena's Anthropic API key was rejected.";
		if (error.status === 429) return 'Claude is rate limiting Athena. Try again in a minute.';
		if (error.status && error.status >= 500) return 'Claude is busy. Try again.';
		return `Claude returned an error (${error.status ?? 'no status'}): ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}
