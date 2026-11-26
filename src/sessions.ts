import { createHash, randomBytes } from 'node:crypto';
import type { Server } from './plex';

/** Someone signed in to the web UI with Plex. Kept in memory only: a restart signs everyone out. */
export interface Session {
	accountId: string;
	name: string;
	/** Their Plex account token, needed to list their servers. Never written down or logged. */
	token: string;
	/** Sent back with every form this session posts, so a page on another site can't post as them. */
	form: string;
	until: number;
	/** Their servers from plex.tv, asked again after a minute. */
	servers?: { at: number; list: Server[] };
}

/** How long a sign-in lasts. */
export const SESSION_DAYS = 7;
const hash = (id: string) => createHash('sha256').update(id).digest('hex');

export class Sessions {
	private readonly sessions = new Map<string, Session>();

	constructor(private readonly now: () => number = Date.now) {}

	/** A new session's id, for the cookie. Only its hash is kept. */
	create(data: Omit<Session, 'until' | 'form'>): string {
		const now = this.now();
		for (const [key, session] of this.sessions) if (session.until <= now) this.sessions.delete(key);
		const id = randomBytes(32).toString('base64url');
		this.sessions.set(hash(id), { ...data, form: randomBytes(32).toString('base64url'), until: now + SESSION_DAYS * 86_400_000 });
		return id;
	}

	get(id: string | undefined): Session | null {
		if (!id) return null;
		const session = this.sessions.get(hash(id));
		if (!session || session.until <= this.now()) return null;
		return session;
	}

	delete(id: string | undefined) {
		if (id) this.sessions.delete(hash(id));
	}
}
