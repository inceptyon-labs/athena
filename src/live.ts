import Anthropic from '@anthropic-ai/sdk';
import { Audiobookshelf } from './abs';
import { compat } from './compat';
import { type AI, claude } from './pick';
import { PlexGate, PlexTV } from './plex';
import { keyName, type ProviderId, providerOf } from './providers';
import { type Effective, Settings } from './settings';
import { type ElevenLabsAccount, elevenLabs, elevenLabsAccount, type Speech, whisper, whisperModel } from './speech';

/** The model that answers, or null until its key (or a local server's address and model) is set. */
export function makeAI(now: Effective, fetcher: typeof fetch = fetch): AI | null {
	const provider = providerOf(now.provider);
	if (provider.id === 'local')
		return now.localURL && now.model ? compat(provider, now.model, { key: null, base: now.localURL, fetcher }) : null;
	const key = now[keyName(provider.id)];
	if (!key || !now.model) return null;
	// One retry: a viewer is waiting on the other end.
	if (provider.id === 'anthropic') return claude(new Anthropic({ apiKey: key, timeout: 45_000, maxRetries: 1 }), now.model);
	return compat(provider, now.model, { key, base: provider.base ?? '', fetcher });
}

/** What Athena answers with right now. Saving settings in the browser rebuilds it, with no restart. */
export class Live {
	ai: AI | null = null;
	provider: ProviderId = 'anthropic';
	model = '';
	jevKey: string | null = null;
	gate: PlexGate | null = null;
	dailyLimit: number | null = null;
	ownerName: string | null = null;
	ownerId: string | null = null;
	ownerToken: string | null = null;
	/** Null until the owner connects Audiobookshelf; until then no automation runs. */
	abs: Audiobookshelf | null = null;
	audibleRegion = 'us';
	/** Jobs that run by themselves every hour. */
	autoJobs: string[] = [];
	/** Speech to text for Titles from the audio: null until chosen and set up. */
	speech: Speech | null = null;
	/** Settings and Automations open from anywhere, not only on the admin port at home. */
	ownerAnywhere = false;
	readonly plexTV: PlexTV;
	private where: string | null = null;
	private account: { key: string; at: number; value: Promise<ElevenLabsAccount | { error: string }> } | null = null;

	constructor(
		readonly settings: Settings,
		readonly fetcher: typeof fetch = fetch,
	) {
		this.plexTV = new PlexTV(settings.effective().clientId, fetcher);
		this.refresh();
	}

	get effective(): Effective {
		return this.settings.effective();
	}

	/**
	 * The ElevenLabs plan's credits for the Automations page, asked at most once a minute; null unless ElevenLabs is
	 * the chosen speech to text and has a key.
	 */
	elevenLabsAccount(now = Date.now()): Promise<ElevenLabsAccount | { error: string }> | null {
		const effective = this.effective;
		const key = effective.elevenlabsKey;
		if (effective.speech !== 'elevenlabs' || !key) return null;
		if (!this.account || this.account.key !== key || now - this.account.at > 60_000)
			this.account = {
				key,
				at: now,
				value: elevenLabsAccount(key, this.fetcher).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
			};
		return this.account.value;
	}

	refresh() {
		const now = this.settings.effective();
		this.ai = makeAI(now, this.fetcher);
		this.provider = now.provider;
		this.model = now.model;
		this.jevKey = now.typesafeKey;
		this.dailyLimit = now.dailyLimit;
		this.ownerName = now.ownerName;
		this.ownerId = now.ownerId;
		this.ownerToken = now.ownerToken;
		this.abs = now.absURL && now.absKey ? new Audiobookshelf(now.absURL, now.absKey, this.fetcher) : null;
		this.audibleRegion = now.audibleRegion;
		this.autoJobs = now.autoJobs;
		this.ownerAnywhere = now.ownerAnywhere;
		const model = now.speech === 'whisper' ? whisperModel() : null;
		this.speech = model ? whisper(model) : now.speech === 'elevenlabs' && now.elevenlabsKey ? elevenLabs(now.elevenlabsKey, { fetcher: this.fetcher }) : null;
		const where = now.plexURL ? `url ${now.plexURL}` : now.server ? `id ${now.server.id}` : null;
		if (where !== this.where) {
			this.where = where;
			const owner = () => this.ownerId;
			const ownerToken = () => this.ownerToken;
			this.gate = now.plexURL
				? new PlexGate({ url: now.plexURL }, this.plexTV, this.fetcher, Date.now, owner, ownerToken)
				: now.server
					? new PlexGate({ id: now.server.id }, this.plexTV, this.fetcher, Date.now, owner, ownerToken)
					: null;
		}
	}
}
