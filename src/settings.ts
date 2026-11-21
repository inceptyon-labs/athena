import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the owner sets in the browser, kept in the data volume. */
export interface Stored {
	/** The Plex server whose people may use Athena, by its machine identifier. */
	server?: { id: string; name: string } | null;
	anthropicKey?: string | null;
	model?: string | null;
	typesafeKey?: string | null;
	/** Describe Its a day for each person except the owner. Null or 0 for no limit. */
	dailyLimit?: number | null;
	/** Athena's https address as friends away from home reach it, through the owner's reverse proxy. */
	publicURL?: string | null;
	/** The owner's name as Plex shows it, for the daily limit's message. Saved whenever the owner saves settings. */
	ownerName?: string | null;
	/** Athena's own id with plex.tv, made once. */
	clientId?: string;
}

/** The settings Athena runs with: an environment variable wins over what was saved. */
export interface Effective {
	plexURL: string | null;
	server: { id: string; name: string } | null;
	anthropicKey: string | null;
	model: string;
	typesafeKey: string | null;
	dailyLimit: number | null;
	publicURL: string | null;
	ownerName: string | null;
	clientId: string;
	/** The environment variable that set each field, shown instead of the field in the browser. */
	env: Partial<Record<'server' | 'anthropicKey' | 'model' | 'typesafeKey', string>>;
}

export const DEFAULT_MODEL = 'claude-haiku-5-5';

const blank = (value: string | undefined) => (value?.trim() ? value.trim() : null);

export class Settings {
	private stored: Stored;
	private readonly file: string;

	constructor(
		private readonly dir: string,
		private readonly env: Record<string, string | undefined> = process.env,
	) {
		this.file = join(dir, 'settings.json');
		this.stored = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Stored) : {};
		if (!this.stored.clientId) this.save({ clientId: randomUUID() });
	}

	effective(): Effective {
		const env = this.env;
		const plexURL = blank(env.PLEX_URL)?.replace(/\/+$/, '') ?? null;
		const anthropicKey = blank(env.ANTHROPIC_API_KEY);
		const model = blank(env.ATHENA_MODEL);
		const typesafeKey = blank(env.TYPESAFE_API_KEY);
		const limit = this.stored.dailyLimit;
		return {
			plexURL,
			server: plexURL ? null : (this.stored.server ?? null),
			anthropicKey: anthropicKey ?? this.stored.anthropicKey ?? null,
			model: model ?? this.stored.model ?? DEFAULT_MODEL,
			typesafeKey: typesafeKey ?? this.stored.typesafeKey ?? null,
			dailyLimit: limit && limit > 0 ? limit : null,
			publicURL: this.stored.publicURL ?? null,
			ownerName: this.stored.ownerName ?? null,
			clientId: this.stored.clientId ?? '',
			env: {
				...(plexURL ? { server: 'PLEX_URL' } : {}),
				...(anthropicKey ? { anthropicKey: 'ANTHROPIC_API_KEY' } : {}),
				...(model ? { model: 'ATHENA_MODEL' } : {}),
				...(typesafeKey ? { typesafeKey: 'TYPESAFE_API_KEY' } : {}),
			},
		};
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
