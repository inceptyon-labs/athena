import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { warn } from './log';
import { isProvider, type KeyName, keyName, modelOf, PROVIDERS, type ProviderId, providerOf } from './providers';

/** What the owner sets in the browser, kept in the data volume. */
export type Stored = {
	/** The Plex server whose people may use Athena, by its machine identifier. */
	server?: { id: string; name: string } | null;
	/** Who reads Describe It. Anthropic until the owner picks another. */
	provider?: ProviderId | null;
	/** The chosen provider's model; for a local server, its own name for it. */
	model?: string | null;
	/** A local server's OpenAI-style API, such as http://192.168.1.10:11434/v1. */
	localURL?: string | null;
	typesafeKey?: string | null;
	/** Describe Its a day for each person except the owner. Null or 0 for no limit. */
	dailyLimit?: number | null;
	/** Athena's https address as friends away from home reach it, through the owner's reverse proxy. */
	publicURL?: string | null;
	/** The owner's name as Plex shows it, for the daily limit's message. Saved whenever the owner saves settings. */
	ownerName?: string | null;
	/**
	 * The plex.tv account id of the owner who set Athena up: the only account treated as the owner, whatever else plex.tv
	 * lists as owning the server. Learned at setup, or on the owner's first visit when Athena was set up before it.
	 */
	ownerId?: string | null;
	/** Athena's own id with plex.tv, made once. */
	clientId?: string;
	/**
	 * The owner's Plex token, from their last sign-in to the web UI: Athena reads who the Plex server is shared with
	 * through it, so a friend's Ithaca sends only its token for this server. Never shown or logged.
	 */
	ownerToken?: string | null;
	/** Audiobookshelf, for automations: its address and an API key from a user who can update books. */
	absURL?: string | null;
	absKey?: string | null;
	/** Audible's store for chapter lookups, such as `us` or `uk`. */
	audibleRegion?: string | null;
	/** The automations the owner set to run by themselves, by job id. */
	autoJobs?: string[] | null;
	/** What turns speech to text for Titles from the audio. */
	speech?: SpeechChoice | null;
	elevenlabsKey?: string | null;
	/**
	 * Settings and Automations also open on the public port and from the internet, behind Plex sign-in. Off: only on the
	 * admin port, from the home network.
	 */
	ownerAnywhere?: boolean | null;
} & Partial<Record<KeyName, string | null>>;

/** ElevenLabs Scribe, or whisper.cpp in the speech image. */
export type SpeechChoice = 'elevenlabs' | 'whisper';

/** The settings Athena runs with: an environment variable wins over what was saved. */
export type Effective = {
	plexURL: string | null;
	server: { id: string; name: string } | null;
	provider: ProviderId;
	/** Empty for a local server not given a model yet. */
	model: string;
	localURL: string | null;
	typesafeKey: string | null;
	dailyLimit: number | null;
	publicURL: string | null;
	ownerName: string | null;
	ownerId: string | null;
	ownerToken: string | null;
	clientId: string;
	absURL: string | null;
	absKey: string | null;
	audibleRegion: string;
	autoJobs: string[];
	speech: SpeechChoice;
	elevenlabsKey: string | null;
	ownerAnywhere: boolean;
	/** The environment variable that set each field, shown instead of the field in the browser. */
	env: Partial<Record<'server' | 'provider' | 'model' | 'typesafeKey' | 'absURL' | 'absKey' | 'elevenlabsKey' | KeyName, string>>;
} & Record<KeyName, string | null>;

export const DEFAULT_MODEL = 'claude-haiku-5-5';

/** Audible's stores, as Audnexus names them, for chapter lookups. */
export const AUDIBLE_REGIONS = [
	{ id: 'us', name: 'United States' },
	{ id: 'ca', name: 'Canada' },
	{ id: 'uk', name: 'United Kingdom' },
	{ id: 'au', name: 'Australia' },
	{ id: 'de', name: 'Germany' },
	{ id: 'fr', name: 'France' },
	{ id: 'it', name: 'Italy' },
	{ id: 'es', name: 'Spain' },
	{ id: 'in', name: 'India' },
	{ id: 'jp', name: 'Japan' },
] as const;

const blank = (value: string | undefined) => (value?.trim() ? value.trim() : null);

/** The provider ATHENA_PROVIDER names, else the one whose list has ATHENA_MODEL (Anthropic for a model it doesn't know). */
function envProvider(env: Record<string, string | undefined>): { id: ProviderId; from: string } | null {
	const named = blank(env.ATHENA_PROVIDER);
	if (named && isProvider(named)) return { id: named, from: 'ATHENA_PROVIDER' };
	const model = blank(env.ATHENA_MODEL);
	if (model) return { id: modelOf(model)?.provider.id ?? 'anthropic', from: 'ATHENA_MODEL' };
	return null;
}

/** The variables that hold keys: each can name a file instead, as `<NAME>_FILE`. */
const SECRETS = [
	...PROVIDERS.flatMap((provider) => (provider.keyEnv ? [provider.keyEnv] : [])),
	'TYPESAFE_API_KEY',
	'ABS_API_KEY',
	'ELEVENLABS_API_KEY',
];

/**
 * The environment with each key variable that isn't set read from the file its `_FILE` twin names, the way Docker
 * secrets and vaults' agents hand keys over, and the name each value came from. Read once, when Athena starts.
 */
function withFiles(env: Record<string, string | undefined>) {
	const resolved = { ...env };
	const from: Record<string, string> = {};
	for (const name of SECRETS) {
		const path = blank(env[`${name}_FILE`]);
		if (blank(env[name]) || !path) continue;
		try {
			const value = blank(readFileSync(path, 'utf8'));
			if (value) {
				resolved[name] = value;
				from[name] = `${name}_FILE`;
			} else warn(`${name}_FILE: ${path} is empty`);
		} catch (error) {
			warn(`${name}_FILE: can't read ${path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
		}
	}
	return { env: resolved, from };
}

export class Settings {
	private stored: Stored;
	private readonly file: string;
	private readonly env: Record<string, string | undefined>;
	/** Where each key variable's value came from, when it was a file. */
	private readonly from: Record<string, string>;

	constructor(
		private readonly dir: string,
		env: Record<string, string | undefined> = process.env,
	) {
		({ env: this.env, from: this.from } = withFiles(env));
		this.file = join(dir, 'settings.json');
		this.stored = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Stored) : {};
		if (!this.stored.clientId) this.save({ clientId: randomUUID() });
	}

	effective(): Effective {
		const env = this.env;
		const stored = this.stored;
		const plexURL = blank(env.PLEX_URL)?.replace(/\/+$/, '') ?? null;
		const fromEnv = envProvider(env);
		const provider = fromEnv?.id ?? (stored.provider && isProvider(stored.provider) ? stored.provider : 'anthropic');
		const envModel = blank(env.ATHENA_MODEL);
		const models = providerOf(provider).models;
		const saved = (stored.provider ?? 'anthropic') === provider ? stored.model : null;
		const fits = saved && (provider === 'local' || models.some((model) => model.id === saved));
		const typesafeKey = blank(env.TYPESAFE_API_KEY);
		const absURL = blank(env.ABS_URL)?.replace(/\/+$/, '') ?? null;
		const absKey = blank(env.ABS_API_KEY);
		const elevenlabsKey = blank(env.ELEVENLABS_API_KEY);
		const limit = stored.dailyLimit;
		const keys = {} as Record<KeyName, string | null>;
		const keyEnv: Effective['env'] = {};
		for (const each of PROVIDERS) {
			if (each.id === 'local') continue;
			const name = keyName(each.id);
			const fromEnvKey = each.keyEnv ? blank(env[each.keyEnv]) : null;
			keys[name] = fromEnvKey ?? stored[name] ?? null;
			if (fromEnvKey && each.keyEnv) keyEnv[name] = this.named(each.keyEnv);
		}
		return {
			plexURL,
			server: plexURL ? null : (stored.server ?? null),
			provider,
			model: envModel ?? (fits ? saved : (models[0]?.id ?? '')),
			localURL: stored.localURL ?? null,
			...keys,
			typesafeKey: typesafeKey ?? stored.typesafeKey ?? null,
			dailyLimit: limit && limit > 0 ? limit : null,
			publicURL: stored.publicURL ?? null,
			ownerName: stored.ownerName ?? null,
			ownerId: stored.ownerId ?? null,
			ownerToken: stored.ownerToken ?? null,
			clientId: stored.clientId ?? '',
			absURL: absURL ?? stored.absURL ?? null,
			absKey: absKey ?? stored.absKey ?? null,
			audibleRegion: stored.audibleRegion && AUDIBLE_REGIONS.some((region) => region.id === stored.audibleRegion) ? stored.audibleRegion : 'us',
			autoJobs: stored.autoJobs ?? [],
			speech: stored.speech === 'whisper' ? 'whisper' : 'elevenlabs',
			elevenlabsKey: elevenlabsKey ?? stored.elevenlabsKey ?? null,
			ownerAnywhere: stored.ownerAnywhere === true,
			env: {
				...(plexURL ? { server: 'PLEX_URL' } : {}),
				...(fromEnv ? { provider: fromEnv.from } : {}),
				...(envModel ? { model: 'ATHENA_MODEL' } : {}),
				...keyEnv,
				...(typesafeKey ? { typesafeKey: this.named('TYPESAFE_API_KEY') } : {}),
				...(absURL ? { absURL: 'ABS_URL' } : {}),
				...(absKey ? { absKey: this.named('ABS_API_KEY') } : {}),
				...(elevenlabsKey ? { elevenlabsKey: this.named('ELEVENLABS_API_KEY') } : {}),
			},
		};
	}

	/** The variable a key came from, as the browser names it: `ANTHROPIC_API_KEY`, or `ANTHROPIC_API_KEY_FILE`. */
	private named(name: string) {
		return this.from[name] ?? name;
	}

	/** Merges and writes the file readable only by Athena, replacing it whole so a crash never leaves half of it. */
	save(patch: Partial<Stored>) {
		this.stored = { ...this.stored, ...patch };
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const temp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(this.stored, null, '\t')}\n`, { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, this.file);
	}
}

/** A key as the browser shows it: enough to tell keys apart, never enough to use. */
export function mask(key: string | null): string | null {
	if (!key) return null;
	return key.length <= 12 ? '…' : `${key.slice(0, 7)}…${key.slice(-4)}`;
}
