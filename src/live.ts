import Anthropic from '@anthropic-ai/sdk';
import { PlexGate, PlexTV } from './plex';
import { type Effective, Settings } from './settings';

/** What Athena answers with right now. Saving settings in the browser rebuilds it, with no restart. */
export class Live {
	client: Anthropic | null = null;
	model = '';
	jevKey: string | null = null;
	gate: PlexGate | null = null;
	dailyLimit: number | null = null;
	ownerName: string | null = null;
	readonly plexTV: PlexTV;
	private key: string | null = null;
	private where: string | null = null;

	constructor(
		readonly settings: Settings,
		private readonly fetcher: typeof fetch = fetch,
	) {
		this.plexTV = new PlexTV(settings.effective().clientId, fetcher);
		this.refresh();
	}

	get effective(): Effective {
		return this.settings.effective();
	}

	refresh() {
		const now = this.settings.effective();
		if (now.anthropicKey !== this.key) {
			this.key = now.anthropicKey;
			// One retry: a viewer is waiting on the other end.
			this.client = now.anthropicKey ? new Anthropic({ apiKey: now.anthropicKey, timeout: 45_000, maxRetries: 1 }) : null;
		}
		this.model = now.model;
		this.jevKey = now.typesafeKey;
		this.dailyLimit = now.dailyLimit;
		this.ownerName = now.ownerName;
		const where = now.plexURL ? `url ${now.plexURL}` : now.server ? `id ${now.server.id}` : null;
		if (where !== this.where) {
			this.where = where;
			this.gate = now.plexURL
				? new PlexGate({ url: now.plexURL }, this.plexTV, this.fetcher)
				: now.server
					? new PlexGate({ id: now.server.id }, this.plexTV, this.fetcher)
					: null;
		}
	}
}
