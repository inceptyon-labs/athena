/** Who answers Describe It: Claude through Anthropic's own API, the rest through their OpenAI-style APIs. */
export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'xai' | 'deepseek' | 'local';
/** The providers that take an API key, and the settings field that holds it. */
export type KeyedProvider = Exclude<ProviderId, 'local'>;
export type KeyName = `${KeyedProvider}Key`;

export interface Model {
	id: string;
	name: string;
	tier: 'Fast' | 'Balanced' | 'Best';
	/** Sent as `reasoning_effort`: how much a thinking model thinks first. The viewer is waiting, so little. */
	effort?: string;
}

export interface Provider {
	id: ProviderId;
	/** The company, as Settings lists it. */
	name: string;
	/** What people call the model, for messages such as "Gemini is busy". */
	brand: string;
	/** Its OpenAI-style API. Anthropic has its own; a local server's is in settings. */
	base?: string;
	/** Where to make a key. */
	keys?: string;
	keyEnv?: string;
	/** Cheapest first, and the first is the default. A local server's models are its own. */
	models: Model[];
	/** `json_schema` structured output, or JSON mode only. */
	json: 'schema' | 'object';
	/** The name of the output cap in its Chat Completions, when it documents one. */
	cap?: 'max_tokens' | 'max_completion_tokens';
}

// Models and their reasoning settings as each provider documents them in November 2026.
export const PROVIDERS: Provider[] = [
	{
		id: 'anthropic',
		name: 'Anthropic',
		brand: 'Claude',
		keys: 'https://console.anthropic.com/settings/keys',
		keyEnv: 'ANTHROPIC_API_KEY',
		models: [
			{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', tier: 'Fast' },
			{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tier: 'Balanced' },
			{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tier: 'Best' },
		],
		json: 'schema',
	},
	{
		id: 'openai',
		name: 'OpenAI',
		brand: 'GPT',
		base: 'https://api.openai.com/v1',
		keys: 'https://platform.openai.com/api-keys',
		keyEnv: 'OPENAI_API_KEY',
		// Sol and Astra refuse "none"; "low" is the least all three take.
		models: [
			{ id: 'gpt-6-luna', name: 'GPT-6 Luna', tier: 'Fast', effort: 'low' },
			{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', tier: 'Balanced', effort: 'low' },
			{ id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', tier: 'Best', effort: 'low' },
		],
		json: 'schema',
		cap: 'max_completion_tokens',
	},
	{
		id: 'gemini',
		name: 'Google',
		brand: 'Gemini',
		base: 'https://generativelanguage.googleapis.com/v1beta/openai',
		keys: 'https://aistudio.google.com/apikey',
		keyEnv: 'GEMINI_API_KEY',
		// Gemini 3 and 4 can't stop thinking; "minimal" is Flash-Lite's least, and Gemini 4 reads it as "low".
		models: [
			{ id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', tier: 'Fast', effort: 'minimal' },
			{ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', tier: 'Balanced', effort: 'low' },
			{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', tier: 'Best', effort: 'low' },
		],
		json: 'schema',
	},
	{
		id: 'xai',
		name: 'xAI',
		brand: 'Grok',
		base: 'https://api.x.ai/v1',
		keys: 'https://console.x.ai',
		keyEnv: 'XAI_API_KEY',
		// Grok 4.3 already thinks little by default, and xAI's pages disagree on whether it takes reasoning_effort.
		models: [
			{ id: 'grok-4.3', name: 'Grok 4.3', tier: 'Fast' },
			{ id: 'grok-4.5', name: 'Grok 4.5', tier: 'Balanced', effort: 'low' },
			{ id: 'grok-4.7', name: 'Grok 4.7', tier: 'Best', effort: 'low' },
		],
		json: 'schema',
		cap: 'max_completion_tokens',
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		brand: 'DeepSeek',
		base: 'https://api.deepseek.com',
		keys: 'https://platform.deepseek.com/api_keys',
		keyEnv: 'DEEPSEEK_API_KEY',
		// Both think by default; Flash answers without, Pro thinks a little.
		models: [
			{ id: 'deepseek-flash', name: 'DeepSeek Flash', tier: 'Fast', effort: 'none' },
			{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'Best', effort: 'low' },
		],
		json: 'object',
		cap: 'max_tokens',
	},
	{
		id: 'local',
		name: 'Local model',
		brand: 'The local model',
		models: [],
		json: 'schema',
		cap: 'max_tokens',
	},
];

export const isProvider = (value: string): value is ProviderId => PROVIDERS.some((provider) => provider.id === value);

export function providerOf(id: ProviderId): Provider {
	return PROVIDERS.find((provider) => provider.id === id) ?? (PROVIDERS[0] as Provider);
}

export const keyName = (id: KeyedProvider): KeyName => `${id}Key`;

/**
 * A local server's API base as Athena calls it, or null unless it is a plain http or https address. Ollama and LM
 * Studio both serve it at /v1, which is added when only the server is given.
 */
export function localBase(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
	const path = url.pathname.replace(/\/+$/, '');
	return `${url.origin}${path || '/v1'}`;
}

/** The provider whose list has this model, if any. */
export function modelOf(id: string): { provider: Provider; model: Model } | null {
	for (const provider of PROVIDERS) {
		const model = provider.models.find((candidate) => candidate.id === id);
		if (model) return { provider, model };
	}
	return null;
}

/** A model's name for the status page: a local model's own id, said to be local. */
export function modelName(id: string): string {
	if (id === 'jev') return 'Jev';
	if (id.startsWith('local:')) return `${id.slice('local:'.length)} (local)`;
	return modelOf(id)?.model.name ?? id;
}
