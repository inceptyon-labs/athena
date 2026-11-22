import { createHash } from 'node:crypto';
import { warn } from './log';

/** Someone with access to the Plex server, as plex.tv names them. */
export interface Viewer {
	id: string;
	name: string;
	/** Owns the Plex server and is the account that set Athena up: may change settings and has no daily limit. */
	owner: boolean;
}

/** A Plex Media Server the account can reach, from plex.tv. */
export interface Server {
	id: string;
	name: string;
	owned: boolean;
}

/** Someone the Plex server is shared with, and their token for that server only. */
export interface SharedToken {
	token: string;
	/** Their plex.tv account id. */
	id: string;
	name: string;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The attributes of one XML tag, entities decoded. */
function xmlAttributes(text: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const [, name, value] of text.matchAll(/([\w:-]+)="([^"]*)"/g)) {
		if (!name) continue;
		fields[name] = (value ?? '').replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, code: string) =>
			code.startsWith('#x') || code.startsWith('#X')
				? String.fromCodePoint(Number.parseInt(code.slice(2), 16))
				: code.startsWith('#')
					? String.fromCodePoint(Number(code.slice(1)))
					: (XML_ENTITIES[code] ?? entity),
		);
	}
	return fields;
}

/** The plex.tv calls Athena makes with a viewer's or the owner's token. */
export class PlexTV {
	constructor(
		/** Athena's own id with plex.tv, the same for every call. */
		private readonly clientId: string,
		private readonly fetcher: typeof fetch = fetch,
		private readonly base = 'https://plex.tv',
	) {}

	private headers(token?: string): Record<string, string> {
		return {
			Accept: 'application/json',
			'X-Plex-Product': 'Athena',
			'X-Plex-Client-Identifier': this.clientId,
			...(token ? { 'X-Plex-Token': token } : {}),
		};
	}

	/** The servers this account reaches, or null when plex.tv refuses the token. Throws when plex.tv can't answer. */
	async servers(token: string): Promise<Server[] | null> {
		const response = await this.fetcher(`${this.base}/api/v2/resources`, {
			headers: this.headers(token),
			signal: AbortSignal.timeout(8000),
		});
		if (response.status === 401 || response.status === 403) return null;
		if (!response.ok) throw new Error(`plex.tv answered ${response.status}`);
		const resources = (await response.json()) as {
			clientIdentifier?: string;
			name?: string;
			owned?: boolean;
			provides?: string;
		}[];
		if (!Array.isArray(resources)) throw new Error('plex.tv listed no resources');
		return resources
			.filter((resource) => resource.clientIdentifier && (resource.provides ?? 'server').includes('server'))
			.map((resource) => ({
				id: resource.clientIdentifier ?? '',
				name: resource.name ?? 'Plex',
				owned: resource.owned === true,
			}));
	}

	/** The account's id and the name Plex shows for it: its title, which a Plex Home profile always has, or its username. */
	async account(token: string): Promise<{ id: string; name: string; thumb: string | null } | null> {
		const response = await this.fetcher(`${this.base}/api/v2/user`, {
			headers: this.headers(token),
			signal: AbortSignal.timeout(8000),
		});
		if (response.status === 401 || response.status === 403) return null;
		if (!response.ok) throw new Error(`plex.tv answered ${response.status}`);
		const user = (await response.json()) as { id?: number; username?: string; title?: string; thumb?: string };
		if (user.id === undefined) throw new Error('plex.tv sent an account without an id');
		return { id: String(user.id), name: user.title || user.username || 'Plex user', thumb: user.thumb ?? null };
	}

	/**
	 * Everyone the server is shared with and their token for it, read with the owner's token: friends and Plex Home
	 * members, never the owner's own device tokens. Null when plex.tv refuses the owner's token. Throws when plex.tv can't
	 * answer. plex.tv answers this one in XML only.
	 */
	async sharedTokens(ownerToken: string, machine: string): Promise<SharedToken[] | null> {
		const response = await this.fetcher(`${this.base}/api/servers/${encodeURIComponent(machine)}/access_tokens.xml`, {
			headers: { ...this.headers(ownerToken), Accept: 'application/xml' },
			signal: AbortSignal.timeout(8000),
		});
		if (response.status === 401 || response.status === 403) return null;
		if (!response.ok) throw new Error(`plex.tv answered ${response.status}`);
		const shared: SharedToken[] = [];
		for (const [, attributes] of (await response.text()).matchAll(/<access_token\b([^>]*)>/g)) {
			const field = xmlAttributes(attributes ?? '');
			if (field.owned === '1' || !field.token || !field.id) continue;
			// A managed Home member has a title and no username.
			shared.push({ token: field.token, id: field.id, name: field.title || field.username || 'Plex user' });
		}
		return shared;
	}

	/** Starts a sign-in: a PIN the viewer approves on app.plex.tv. */
	async pin(): Promise<{ id: number; code: string }> {
		const response = await this.fetcher(`${this.base}/api/v2/pins?strong=true`, {
			method: 'POST',
			headers: this.headers(),
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) throw new Error(`plex.tv answered ${response.status}`);
		const pin = (await response.json()) as { id?: number; code?: string };
		if (!pin.id || !pin.code) throw new Error('plex.tv sent no PIN');
		return { id: pin.id, code: pin.code };
	}

	/** The account token once the viewer has approved the PIN, otherwise null. */
	async token(pinId: number): Promise<string | null> {
		const response = await this.fetcher(`${this.base}/api/v2/pins/${pinId}`, {
			headers: this.headers(),
			signal: AbortSignal.timeout(8000),
		});
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`plex.tv answered ${response.status}`);
		return ((await response.json()) as { authToken?: string | null }).authToken || null;
	}

	/** The page on app.plex.tv where the viewer approves the PIN, which then sends them to `forward`. */
	authURL(code: string, forward: string): string {
		const query = new URLSearchParams({
			clientID: this.clientId,
			code,
			forwardUrl: forward,
			'context[device][product]': 'Athena',
		});
		return `https://app.plex.tv/auth#?${query}`;
	}
}

/**
 * Who may ask: anyone who can use the Plex server Athena sits beside. Ithaca sends the viewer's token for that server
 * (`X-Plex-Token`), never their account token, which would open their whole Plex account to whoever runs Athena. With
 * the owner's token, Athena asks plex.tv who the server is shared with and their tokens for it (`sharedTokens`), so
 * friends and Plex Home members get in and stopping a share in Plex stops Athena too. The owner's token for their own
 * server is their account token, and an older Ithaca sends account tokens, so a token not shared that way is still
 * checked as an account token: Athena asks plex.tv which servers it reaches. The local server can't answer any of this:
 * Plex lets home-network addresses in without signing in. Answers are remembered for a few minutes, by a hash of the
 * token, never the token itself.
 */
export class PlexGate {
	private machine: string | null;
	private readonly allowed = new Map<string, { until: number; viewer: Viewer }>();
	private readonly refused = new Map<string, number>();
	/** Who the server is shared with, by a hash of each one's token, read with the owner's token at most once a minute. */
	private shared: { at: number; ownerToken: string; viewers: Map<string, Viewer> } | null = null;
	/** The owner's token plex.tv last refused; asked with again only once the owner signs in anew. */
	private refusedOwnerToken: string | null = null;

	/**
	 * @param server the Plex server: its machine identifier, or its address (`PLEX_URL`), read only for that identifier.
	 */
	constructor(
		private readonly server: { id: string } | { url: string },
		private readonly plexTV: PlexTV,
		private readonly fetcher: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
		/** The account that set Athena up, by its plex.tv id; null until it is known. */
		private readonly owner: () => string | null = () => null,
		/** The owner's Plex token, saved when they sign in; null for an Athena set up before it was kept. */
		private readonly ownerToken: () => string | null = () => null,
	) {
		this.machine = 'id' in server ? server.id : null;
	}

	/** The server's machine identifier. Null until the server answers. */
	async machineIdentifier(): Promise<string | null> {
		if (this.machine || !('url' in this.server)) return this.machine;
		const url = this.server.url;
		try {
			const response = await this.fetcher(`${url}/identity`, {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) {
				const body = (await response.json()) as { MediaContainer?: { machineIdentifier?: string } };
				this.machine = body.MediaContainer?.machineIdentifier ?? null;
			}
		} catch (error) {
			warn(`plex identity at ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return this.machine;
	}

	/** The viewer when the account can reach this server, otherwise null. Throws when Plex can't be reached or answers oddly. */
	async viewer(token: string): Promise<Viewer | null> {
		const key = createHash('sha256').update(token).digest('hex');
		const now = this.now();
		const known = this.allowed.get(key);
		if (known && known.until > now) return this.judged(known.viewer);
		if ((this.refused.get(key) ?? 0) > now) return null;
		const machine = await this.machineIdentifier();
		if (!machine) throw new Error("the Plex server didn't say which server it is");
		const shared = (await this.sharedViewers(machine))?.get(key);
		if (shared) {
			this.remember(() => this.allowed.set(key, { until: now + 10 * 60_000, viewer: shared }));
			return shared;
		}
		const [servers, account] = await Promise.all([this.plexTV.servers(token), this.plexTV.account(token)]);
		const server = servers?.find((candidate) => candidate.id === machine);
		if (!server || !account) {
			this.remember(() => this.refused.set(key, now + 60_000));
			return null;
		}
		const viewer = { id: account.id, name: account.name, owner: server.owned };
		this.remember(() => this.allowed.set(key, { until: now + 10 * 60_000, viewer }));
		return this.judged(viewer);
	}

	/** Whether a viewer's token for the server is enough, which Ithaca reads from `/healthz` before choosing what to send. */
	acceptsServerTokens(): boolean {
		const ownerToken = this.ownerToken();
		return ownerToken !== null && ownerToken !== this.refusedOwnerToken;
	}

	/** Null without a usable owner's token. Throws when plex.tv can't answer. */
	private async sharedViewers(machine: string): Promise<Map<string, Viewer> | null> {
		const ownerToken = this.ownerToken();
		if (!ownerToken || ownerToken === this.refusedOwnerToken) return null;
		const now = this.now();
		if (this.shared && this.shared.ownerToken === ownerToken && now - this.shared.at < 60_000) return this.shared.viewers;
		const list = await this.plexTV.sharedTokens(ownerToken, machine);
		if (!list) {
			warn("plex.tv refused the owner's token: friends need the owner to sign in to Athena again");
			this.refusedOwnerToken = ownerToken;
			this.shared = null;
			return null;
		}
		const viewers = new Map<string, Viewer>();
		for (const entry of list) {
			viewers.set(createHash('sha256').update(entry.token).digest('hex'), { id: entry.id, name: entry.name, owner: false });
		}
		this.shared = { at: now, ownerToken, viewers };
		return viewers;
	}

	/** plex.tv's word that an account owns the server isn't enough once the owner who set Athena up is known. */
	private judged(viewer: Viewer): Viewer {
		const owner = this.owner();
		return viewer.owner && owner !== null && viewer.id !== owner ? { ...viewer, owner: false } : viewer;
	}

	private remember(set: () => void) {
		if (this.allowed.size + this.refused.size > 1000) {
			this.allowed.clear();
			this.refused.clear();
		}
		set();
	}
}
