import { createHash } from 'node:crypto';
import { warn } from './log';

/**
 * Who may ask: anyone who can use the Plex server Athena sits beside. Ithaca sends the viewer's Plex account token
 * (`X-Plex-Token`), and Athena asks plex.tv which servers that account can reach, so the owner, Plex Home profiles and
 * friends the library is shared with get in, and stopping a share in Plex stops Athena too. The local server can't
 * answer this: Plex lets home-network addresses in without signing in. Answers are remembered for a few minutes, by a
 * hash of the token, never the token itself.
 */
export class PlexGate {
	private machine: string | null = null;
	private readonly allowed = new Map<string, number>();
	private readonly refused = new Map<string, number>();

	/** @param url the Plex server's address, read only for its machine identifier. */
	constructor(
		private readonly url: string,
		private readonly fetcher: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
		private readonly plexTV = 'https://plex.tv',
	) {}

	/** The server's machine identifier. Null until the server answers. */
	async machineIdentifier(): Promise<string | null> {
		if (this.machine) return this.machine;
		try {
			const response = await this.fetcher(`${this.url}/identity`, {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) {
				const body = (await response.json()) as { MediaContainer?: { machineIdentifier?: string } };
				this.machine = body.MediaContainer?.machineIdentifier ?? null;
			}
		} catch (error) {
			warn(`plex identity at ${this.url} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return this.machine;
	}

	/** Whether the account can reach this server. Throws when Plex can't be reached or answers oddly. */
	async allows(token: string): Promise<boolean> {
		const key = createHash('sha256').update(token).digest('hex');
		const now = this.now();
		if ((this.allowed.get(key) ?? 0) > now) return true;
		if ((this.refused.get(key) ?? 0) > now) return false;
		const machine = await this.machineIdentifier();
		if (!machine) throw new Error(`Plex at ${this.url} didn't say which server it is`);
		const response = await this.fetcher(`${this.plexTV}/api/v2/resources`, {
			headers: {
				Accept: 'application/json',
				'X-Plex-Token': token,
				'X-Plex-Product': 'Athena',
				'X-Plex-Client-Identifier': `athena-${machine}`,
			},
			signal: AbortSignal.timeout(8000),
		});
		if (response.status === 401 || response.status === 403) {
			this.remember(this.refused, key, now + 60_000);
			return false;
		}
		if (!response.ok) throw new Error(`plex.tv answered ${response.status}`);
		const resources = (await response.json()) as { clientIdentifier?: string }[];
		const ok = Array.isArray(resources) && resources.some((resource) => resource.clientIdentifier === machine);
		this.remember(ok ? this.allowed : this.refused, key, now + (ok ? 10 * 60_000 : 60_000));
		return ok;
	}

	private remember(map: Map<string, number>, key: string, until: number) {
		if (this.allowed.size + this.refused.size > 1000) {
			this.allowed.clear();
			this.refused.clear();
		}
		map.set(key, until);
	}
}
