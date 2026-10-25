import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const Title = z.object({
	id: z.string().min(1).max(32),
	title: z.string().min(1).max(300),
	year: z.number().int().optional(),
	genres: z.array(z.string().max(60)).max(12).optional(),
	/** A movie's running time, or a show's typical episode. */
	minutes: z.number().int().positive().optional(),
	contentRating: z.string().max(20).optional(),
	seen: z.boolean().optional(),
	rating: z.enum(['loved', 'liked', 'disliked']).optional(),
});

const Names = z.array(z.string().max(300)).max(30).optional();

/** What Ithaca sends: the request, and the titles that already fit its filters. */
export const PickRequest = z.object({
	request: z.string().trim().min(1).max(500),
	kind: z.enum(['movie', 'show']),
	count: z.number().int().min(1).max(12).default(9),
	titles: z.array(Title).min(1).max(5000),
	taste: z.object({ loved: Names, liked: Names, disliked: Names, recent: Names }).optional(),
	/** Ids already on screen or queued: never picked again. */
	exclude: z.array(z.string().max(32)).max(5000).optional(),
});
export type PickRequest = z.infer<typeof PickRequest>;

const PickResult = z.object({
	picks: z.array(z.object({ id: z.string(), reason: z.string() })),
});
export type Pick = z.infer<typeof PickResult>['picks'][number];

export const SYSTEM = `You choose what a household watches from their own Plex library. You get the library as a list with ids, sometimes what this viewer loved, liked, disliked or watched lately, and a request in their own words.

Pick the titles from the list that best fit the request.
- Only use ids from the list. Never suggest anything that is not on it.
- What the request asks for is a requirement: mood, genre, length, era, who is watching, what to avoid. The viewer's taste only decides between titles that fit equally well.
- Lengths are in minutes. For a TV show, the length is a typical episode.
- Unless the request is narrow, make the picks different from each other.
- Best fit first. Return fewer picks than asked when fewer fit, and none when nothing does.
- Each reason is one sentence of at most 15 words on why the title fits this request. Be specific, give no spoilers and do not repeat the title.`;

function titleLine(title: PickRequest['titles'][number]): string {
	const name = title.year ? `${title.title} (${title.year})` : title.title;
	const history = [title.seen ? 'seen' : '', title.rating ?? ''].filter(Boolean).join(', ');
	return [
		title.id,
		name,
		(title.genres ?? []).join(', '),
		title.minutes ? `${title.minutes} min` : '',
		title.contentRating ?? '',
		history,
	].join(' | ');
}

/**
 * The library and the viewer's taste. It changes only when the filters or the
 * ratings do, so it is the cached part of the prompt.
 */
export function libraryText(req: PickRequest): string {
	const noun = req.kind === 'movie' ? 'movies' : 'TV shows';
	const parts = [
		`The household's ${noun}, one per line: id | title (year) | genres | length | age rating | this viewer's history`,
		req.titles.map(titleLine).join('\n'),
	];
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

export function requestText(req: PickRequest): string {
	const parts = [`Request: ${JSON.stringify(req.request)}`];
	if (req.exclude?.length) parts.push(`Already suggested, leave these ids out: ${req.exclude.join(', ')}`);
	parts.push(`Pick up to ${req.count}.`);
	return parts.join('\n');
}

/** The model's picks, keeping only ids from the list, each once, never excluded ones. */
export function cleanPicks(picks: Pick[], req: PickRequest): Pick[] {
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

export class PickError extends Error {
	constructor(message: string, readonly status: 502 | 503 = 502) {
		super(message);
	}
}

export interface PickOutcome {
	picks: Pick[];
	usage: Anthropic.Usage;
}

export async function pick(client: Anthropic, model: string, req: PickRequest): Promise<PickOutcome> {
	const response = await client.messages
		.parse({
			model,
			max_tokens: 2048,
			system: SYSTEM,
			// Choosing from a list needs little thinking, and the viewer is waiting.
			output_config: { effort: 'low', format: zodOutputFormat(PickResult) },
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: libraryText(req), cache_control: { type: 'ephemeral' } },
						{ type: 'text', text: requestText(req) },
					],
				},
			],
		})
		.catch((error: unknown) => {
			throw new PickError(describe(error));
		});
	if (response.stop_reason === 'refusal') throw new PickError('Claude declined that request.');
	if (!response.parsed_output) throw new PickError(`Claude's answer was cut off (${response.stop_reason}).`);
	return { picks: cleanPicks(response.parsed_output.picks, req), usage: response.usage };
}

function describe(error: unknown): string {
	if (error instanceof Anthropic.APIError) {
		if (error.status === 401 || error.status === 403) return "Mentor's Anthropic API key was rejected.";
		if (error.status === 429) return 'Claude is rate limiting Mentor. Try again in a minute.';
		if (error.status && error.status >= 500) return 'Claude is busy. Try again.';
		return `Claude returned an error (${error.status ?? 'no status'}): ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}
