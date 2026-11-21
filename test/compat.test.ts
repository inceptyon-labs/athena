import { describe, expect, test } from 'bun:test';
import { answerJSON, compat, listModels } from '../src/compat';
import { libraryText, PickRequest, SYSTEM } from '../src/pick';
import { cost, perDescribeIt, TYPICAL } from '../src/prices';
import { localBase, providerOf } from '../src/providers';

const req = PickRequest.parse({
	request: 'something funny',
	kind: 'movie',
	count: 2,
	titles: [
		{ id: '1', title: 'Airplane!', year: 1980 },
		{ id: '2', title: 'Hot Fuzz', year: 2007 },
	],
	suggest: 1,
});

const answer = {
	minimums: { critics: 8, audience: null, imdb: null },
	picks: [
		{ id: '9', reason: 'Not on the list.' },
		{ id: '1', reason: 'Gag a second.' },
	],
	suggestions: [{ title: 'Top Secret!', year: 1984, discoverId: 'nope', reason: 'Same team.' }],
};

/** A provider that answers with `content` and records what it was sent. */
function server(content: string, usage: object = {}, statuses: number[] = []) {
	const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		sent.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		const status = statuses.shift();
		if (status) return new Response('{"error":{"message":"nope"}}', { status });
		return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }], usage });
	}) as typeof fetch;
	return { fetcher, sent };
}

describe('OpenAI-style providers', () => {
	test('the cached part goes first, with the tier’s thinking, the schema and the key', async () => {
		const { fetcher, sent } = server(JSON.stringify(answer));
		const ai = compat(providerOf('openai'), 'gpt-6.2-sol', { key: 'sk-test', base: 'https://api.openai.com/v1', fetcher });
		await ai.pick(req);
		const [call] = sent;
		expect(call?.url).toBe('https://api.openai.com/v1/chat/completions');
		expect(call?.headers.get('Authorization')).toBe('Bearer sk-test');
		const messages = call?.body.messages as { role: string; content: string }[];
		expect(messages[0]?.content.startsWith(SYSTEM)).toBe(true);
		expect(messages[1]?.content.startsWith(libraryText(req))).toBe(true);
		expect(call?.body.reasoning_effort).toBe('low');
		expect(call?.body.max_completion_tokens).toBe(8192);
		expect((call?.body.response_format as { type: string }).type).toBe('json_schema');
	});

	test('DeepSeek gets JSON mode and its own cap; Flash answers without thinking', async () => {
		const { fetcher, sent } = server(JSON.stringify(answer));
		await compat(providerOf('deepseek'), 'deepseek-flash', { key: 'k', base: 'https://api.deepseek.com', fetcher }).pick(req);
		expect(sent[0]?.body.response_format).toEqual({ type: 'json_object' });
		expect(sent[0]?.body.max_tokens).toBe(8192);
		expect(sent[0]?.body.reasoning_effort).toBe('none');
	});

	test('the answer is cleaned like Claude’s, and cached tokens are counted apart', async () => {
		const { fetcher } = server(JSON.stringify(answer), {
			prompt_tokens: 25_000,
			completion_tokens: 300,
			prompt_tokens_details: { cached_tokens: 24_000 },
		});
		const ai = compat(providerOf('gemini'), 'gemini-4-hydrogen', { key: 'k', base: 'https://g', fetcher });
		const outcome = await ai.pick(req);
		expect(ai.by).toBe('gemini-4-hydrogen');
		expect(outcome.picks).toEqual([{ id: '1', reason: 'Gag a second.' }]);
		expect(outcome.suggestions).toEqual([{ title: 'Top Secret!', year: 1984, discoverId: null, reason: 'Same team.' }]);
		expect(outcome.minimums.critics).toBe(80);
		expect(outcome.usage).toEqual({ input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 0 });
	});

	test('a busy provider is asked once more; a rejected key is said plainly', async () => {
		const busy = server(JSON.stringify(answer), {}, [503]);
		const ai = compat(providerOf('xai'), 'grok-4.5', { key: 'k', base: 'https://x', fetcher: busy.fetcher });
		expect((await ai.pick(req)).picks).toHaveLength(1);
		expect(busy.sent).toHaveLength(2);
		const rejected = server('', {}, [401]);
		const refused = compat(providerOf('openai'), 'gpt-6-luna', { key: 'k', base: 'https://o', fetcher: rejected.fetcher });
		await expect(refused.pick(req)).rejects.toThrow("Athena's OpenAI API key was rejected.");
		const down = server('', {}, [500, 500]);
		await expect(compat(providerOf('xai'), 'grok-4.3', { key: 'k', base: 'https://x', fetcher: down.fetcher }).pick(req)).rejects.toThrow(
			'Grok is busy. Try again.',
		);
	});

	test('an answer that is not the JSON asked for is an error, not empty picks', async () => {
		const { fetcher } = server('   ');
		const ai = compat(providerOf('deepseek'), 'deepseek-flash', { key: 'k', base: 'https://d', fetcher });
		await expect(ai.pick(req)).rejects.toThrow("DeepSeek's answer wasn't the JSON Athena asked for.");
	});
});

describe('a local model', () => {
	test('is called without a key, logged as local and costs nothing', async () => {
		const { fetcher, sent } = server(JSON.stringify(answer), { prompt_tokens: 25_000, completion_tokens: 300 });
		const ai = compat(providerOf('local'), 'llama-test', { key: null, base: 'http://ollama:11434/v1', fetcher });
		const outcome = await ai.pick(req);
		expect(sent[0]?.headers.get('Authorization')).toBeNull();
		expect(ai.by).toBe('local:llama-test');
		expect(cost(ai.by, outcome.usage)).toBe(0);
	});

	test('its JSON is found past thinking and code fences', () => {
		expect(answerJSON('<think>{"x": 1} maybe</think>\n```json\n{"picks": []}\n```')).toEqual({ picks: [] });
	});

	test('its address takes Ollama’s or LM Studio’s server alone, adding /v1', () => {
		expect(localBase('http://192.168.1.10:11434')).toBe('http://192.168.1.10:11434/v1');
		expect(localBase('http://192.168.1.10:1234/v1/')).toBe('http://192.168.1.10:1234/v1');
		expect(localBase('ftp://nas/v1')).toBeNull();
		expect(localBase('not an address')).toBeNull();
	});
});

test('a key’s models are listed without Gemini’s prefix, and a refused key says so', async () => {
	const fetcher = (async (_url: string | URL | Request, init?: RequestInit) =>
		new Headers(init?.headers).get('Authorization') === 'Bearer good'
			? Response.json({ data: [{ id: 'models/gemini-4-hydrogen' }, { id: 'gemini-4-carbon' }] })
			: new Response('', { status: 400 })) as typeof fetch;
	expect(await listModels('https://g', 'good', fetcher)).toEqual(['gemini-4-hydrogen', 'gemini-4-carbon']);
	expect(await listModels('https://g', 'bad', fetcher)).toBe('rejected');
});

test('every listed model has a price, and a Describe It on a Fast tier stays around a cent or less', () => {
	for (const id of ['anthropic', 'openai', 'gemini', 'xai', 'deepseek'] as const)
		for (const model of providerOf(id).models) expect(perDescribeIt(model.id, TYPICAL, false)).not.toBeNull();
	for (const id of ['claude-haiku-5-5', 'gpt-6-luna', 'gemini-3.5-flash-lite', 'deepseek-flash'])
		expect(perDescribeIt(id, TYPICAL, false) ?? 1).toBeLessThan(0.02);
});

test("a Describe It is two requests with the library; with Jev, only the suggestions one costs much", () => {
	const both = perDescribeIt('claude-sonnet-5-5', { picks: 25_000, suggestions: 29_000 }, false) ?? 0;
	expect(both).toBeCloseTo((54_000 * 2 + 800 * 10) / 1e6, 6);
	const withJev = perDescribeIt('claude-sonnet-5-5', { picks: 25_000, suggestions: 29_000 }, true) ?? 0;
	expect(withJev).toBeCloseTo((29_000 * 2 + 400 * 10 + 25_000 * 0.042) / 1e6, 6);
	expect(perDescribeIt('local:llama', TYPICAL, false)).toBe(0);
});
