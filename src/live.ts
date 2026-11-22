import Anthropic from '@anthropic-ai/sdk';
import { compat } from './compat';
import { type AI, claude } from './pick';
import { PlexGate, PlexTV } from './plex';
import { keyName, type ProviderId, providerOf } from './providers';
import { type Effective, Settings } from './settings';

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
	readonly plexTV: PlexTV;
	private where: string | null = null;

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

	refresh() {
		const now = this.settings.effective();
		this.ai = makeAI(now, this.fetcher);
		this.provider = now.provider;
		this.model = now.model;
		this.jevKey = now.typesafeKey;
		this.dailyLimit = now.dailyLimit;
		this.ownerName = now.ownerName;
		this.ownerId = now.ownerId;
		const where = now.plexURL ? `url ${now.plexURL}` : now.server ? `id ${now.server.id}` : null;
		if (where !== this.where) {
			this.where = where;
			const owner = () => this.ownerId;
			this.gate = now.plexURL
				? new PlexGate({ url: now.plexURL }, this.plexTV, this.fetcher, Date.now, owner)
				: now.server
					? new PlexGate({ id: now.server.id }, this.plexTV, this.fetcher, Date.now, owner)
					: null;
		}
	}
}
