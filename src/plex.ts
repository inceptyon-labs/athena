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
 * Who may ask: anyone who can use the Plex server Athena sits beside. Ithaca sends the viewer's Plex account token
 * (`X-Plex-Token`), and Athena asks plex.tv which servers that account can reach, so the owner, Plex Home profiles and
 * friends the library is shared with get in, and stopping a share in Plex stops Athena too. The local server can't
 * answer this: Plex lets home-network addresses in without signing in. Answers are remembered for a few minutes, by a
 * hash of the token, never the token itself.
 */
export class PlexGate {
	private machine: string | null;
	private readonly allowed = new Map<string, { until: number; viewer: Viewer }>();
	private readonly refused = new Map<string, number>();

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
