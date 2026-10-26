import type { Minimums, Pick, PickOutcome, PickRequest } from './pick';
import { PickError } from './pick';

/**
 * Library picks from Jev, TypeSafe's decision model: one yes-or-no question
 * per title, all answered at once in well under a second. Jev writes no text,
 * so its picks carry an empty reason, and it can only choose from the list, so
 * suggestions stay with Claude.
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
/** One call takes about 1,000 title questions before it runs out of tokens. */
const BATCH = 500;
/**
 * How likely a yes has to be for a title to fit. On the household's library,
 * 0.5 left good fits out of narrow requests ("a slow burn mystery set in a
 * small town" kept three).
 */
const FITS = 0.4;

const PERCENT_LEVELS = ['50', '60', '65', '70', '75', '80', '85', '90', '95'];
const IMDB_LEVELS = ['6', '6.5', '7', '7.5', '8', '8.5', '9'];

type Title = PickRequest['titles'][number];
type Answer = { noul?: number; choice?: string };

const noun = (req: PickRequest) => (req.kind === 'movie' ? 'movie' : 'TV show');

/** The request, and how to judge it. Each question is one title. */
export function jevState(req: PickRequest): string {
	const length = req.kind === 'show' ? " A show's length is a typical episode." : '';
	return (
		`A viewer asked for something to watch tonight: ${JSON.stringify(req.request)}. ` +
		`Each question is one ${noun(req)} from their library. ` +
		`Yes means the ${noun(req)} fits every part of the request, judged from what you know about it.${length}`
	);
}

export function jevTitleLine(title: Title): string {
	const scores = title.scores;
	return [
		title.year ? `${title.title} (${title.year})` : title.title,
		(title.genres ?? []).join(', '),
		title.minutes ? `${title.minutes} min` : '',
		title.contentRating ?? '',
		[
			scores?.critics !== undefined ? `RT critics ${scores.critics}%` : '',
			scores?.audience !== undefined ? `RT audience ${scores.audience}%` : '',
			scores?.imdb !== undefined ? `IMDb ${scores.imdb}` : '',
			scores?.tmdb !== undefined ? `TMDB ${scores.tmdb}` : '',
		]
			.filter(Boolean)
			.join(', '),
	]
		.filter(Boolean)
		.join(' | ');
}

function minimumQuestion(instructions: string, levels: string[], what: string, level: (value: string) => string) {
	return {
		type: 'choice',
		instructions,
		criteria: Object.fromEntries([
			['none', `The request sets no minimum ${what}.`],
			...levels.map((value) => [value, level(value)]),
		]),
	};
}

/** Tested on ten requests: naming what sets each minimum keeps "over 8 rotten tomatoes" off the audience score. */
const MINIMUM_QUESTIONS = {
	minCritics: minimumQuestion(
		'What minimum Rotten Tomatoes critics score (the Tomatometer) does the request set? "Rotten Tomatoes" or "RT" alone means the critics score. A score out of 10 is ten times that in percent: 8 is 80.',
		PERCENT_LEVELS,
		'critics score',
		(value) => `At least ${value}%.`,
	),
	minAudience: minimumQuestion(
		'What minimum Rotten Tomatoes audience score does the request set? Only a request that names the audience score, or audiences, sets one.',
		PERCENT_LEVELS,
		'audience score',
		(value) => `At least ${value}%.`,
	),
	minImdb: minimumQuestion(
		'What minimum IMDb rating out of 10 does the request set? Only a request that names IMDb sets one.',
		IMDB_LEVELS,
		'IMDb rating',
		(value) => `At least ${value} out of 10.`,
	),
};

/** The questions for one batch of titles, keyed by their place in the request. The first batch also reads the minimums. */
export function jevQuestions(req: PickRequest, start: number): Record<string, unknown> {
	const questions: Record<string, unknown> = start === 0 ? { ...MINIMUM_QUESTIONS } : {};
	req.titles.slice(start, start + BATCH).forEach((title, offset) => {
		questions[`t${start + offset}`] = { type: 'noul', instructions: `${noun(req)}: ${jevTitleLine(title)}` };
	});
	return questions;
}

export function readMinimums(answers: Record<string, Answer>): Minimums {
	const read = (answer: Answer | undefined) => {
		const value = Number(answer?.choice);
		return answer?.choice && answer.choice !== 'none' && Number.isFinite(value) ? value : null;
	};
	return { critics: read(answers.minCritics), audience: read(answers.minAudience), imdb: read(answers.minImdb) };
}

/**
 * The titles that fit, most likely first, up to the count: never an excluded
 * one or one listed below a minimum. A title without that score can still fit,
 * as on Ithaca's own check.
 */
export function rankPicks(req: PickRequest, fits: number[], minimums: Minimums): Pick[] {
	const excluded = new Set(req.exclude ?? []);
	const below = (title: Title) => {
		const scores = title.scores;
		return (
			(minimums.critics !== null && scores?.critics !== undefined && scores.critics < minimums.critics) ||
			(minimums.audience !== null && scores?.audience !== undefined && scores.audience < minimums.audience) ||
			(minimums.imdb !== null && scores?.imdb !== undefined && scores.imdb < minimums.imdb)
		);
	};
	return req.titles
		.map((title, index) => ({ title, fit: fits[index] ?? 0 }))
		.filter(({ title, fit }) => fit >= FITS && !excluded.has(title.id) && !below(title))
		.sort((a, b) => b.fit - a.fit)
		.slice(0, req.count)
		.map(({ title }) => ({ id: title.id, reason: '' }));
}

async function ask(key: string, req: PickRequest, start: number) {
	const response = await fetch(ENDPOINT, {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: MODEL, state: jevState(req), questions: jevQuestions(req, start) }),
		signal: AbortSignal.timeout(10_000),
	}).catch((error: unknown) => {
		throw new PickError(`Jev did not answer: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (!response.ok) throw new PickError(await describe(response));
	const body = (await response.json()) as {
		answers?: Record<string, Answer>;
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	return { answers: body.answers ?? {}, usage: body.usage ?? {} };
}

export async function pickWithJev(key: string, req: PickRequest): Promise<PickOutcome> {
	const starts = Array.from({ length: Math.ceil(req.titles.length / BATCH) }, (_, i) => i * BATCH);
	const batches = await Promise.all(starts.map((start) => ask(key, req, start)));
	const answers: Record<string, Answer> = Object.assign({}, ...batches.map((batch) => batch.answers));
	const fits = req.titles.map((_, index) => answers[`t${index}`]?.noul ?? 0);
	const minimums = readMinimums(answers);
	return {
		picks: rankPicks(req, fits, minimums),
		suggestions: [],
		minimums,
		usage: {
			input_tokens: batches.reduce((sum, batch) => sum + (batch.usage.input_tokens ?? 0), 0),
			output_tokens: batches.reduce((sum, batch) => sum + (batch.usage.output_tokens ?? 0), 0),
		},
	};
}

async function describe(response: Response): Promise<string> {
	if (response.status === 401) return "Mentor's TypeSafe API key was rejected.";
	if (response.status === 429) return 'Jev is rate limiting Mentor. Try again in a minute.';
	if (response.status >= 500) return 'Jev is busy. Try again.';
	const detail = (await response.text().catch(() => '')).slice(0, 300);
	return `Jev returned an error (${response.status}): ${detail}`;
}
