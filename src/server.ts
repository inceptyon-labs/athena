import { Hono } from 'hono';
import { z } from 'zod';
import { pickWithJev } from './jev';
import { log, warn } from './log';
import { type AI, PickError, PickRequest, type PickOutcome } from './pick';
import type { Viewer } from './plex';
import type { ProviderId } from './providers';
import { cost } from './prices';
import type { Usage } from './usage';

/** Checks callers against the Plex server. */
export interface Gate {
	machineIdentifier(): Promise<string | null>;
	viewer(token: string): Promise<Viewer | null>;
}

/** Read on every request, so settings saved in the browser apply at once. */
export interface Deps {
	/** The model that answers suggestions, and library picks without Jev. Null until it is set up. */
	ai: AI | null;
	/** What the owner chose, for the health check, even before it is set up. */
	provider: ProviderId;
	model: string;
	/** TypeSafe's key. With it, library picks go to Jev and only suggestions to Claude. */
	jevKey?: string | null;
	/** Null until a Plex server is chosen; until then Athena answers no one. */
	gate?: Gate | null;
	/** Describe Its a day for each person except the server's owner. */
	dailyLimit?: number | null;
	/** The owner's name, for the message past the daily limit. */
	ownerName?: string | null;
	/** Where requests are logged for the status page and the daily limit. */
	usage?: Usage | null;
	/** Replaced in tests. */
	pickWithJev?: (key: string, req: PickRequest) => Promise<PickOutcome>;
}

const NO_USAGE: PickOutcome['usage'] = { input_tokens: 0, output_tokens: 0 };

export function createApp(deps: Deps) {
	const app = new Hono();
	const runJev = deps.pickWithJev ?? pickWithJev;

	/** Jev for picks from the library; the chosen model for suggestions, and when Jev fails. */
	async function answer(req: PickRequest): Promise<{ outcome: PickOutcome; by: string }> {
		const { ai, jevKey } = deps;
		if (jevKey && req.suggest === 0) {
			try {
				return { outcome: await runJev(jevKey, req), by: 'jev' };
			} catch (error) {
				if (!ai) throw error;
				warn(`jev failed, asking ${ai.by}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!ai) throw new PickError("Athena's AI model isn't set up yet.", 503);
		return { outcome: await ai.pick(req), by: ai.by };
	}

	// `service` is how Ithaca recognises Athena when it looks for it on the Plex server's address, `server` is the Plex
	// server whose token Ithaca sends, and `provider` is where what the viewer types goes.
	app.get('/healthz', async (c) => {
		const gate = deps.gate ?? null;
		return c.json({
			ok: true,
			ready: gate !== null && (deps.ai !== null || Boolean(deps.jevKey)),
			model: deps.model,
			provider: deps.provider,
			jev: Boolean(deps.jevKey),
			service: 'athena',
			server: gate ? await gate.machineIdentifier() : null,
		});
	});

	app.post('/v1/pick', async (c) => {
		const gate = deps.gate ?? null;
		if (!gate) return c.json({ error: "Athena isn't set up yet. Its owner finishes setting it up in a browser." }, 503);
		const token = c.req.header('X-Plex-Token');
		let viewer: Viewer | null = null;
		try {
			viewer = token ? await gate.viewer(token) : null;
		} catch (error) {
			warn(`plex sign-in check failed: ${error instanceof Error ? error.message : String(error)}`);
			return c.json({ error: "Athena couldn't reach Plex to check your sign-in. Try again in a minute." }, 502);
		}
		if (!viewer) return c.json({ error: 'Athena only answers people with access to its Plex server.' }, 401);
		if (!deps.ai && !deps.jevKey) return c.json({ error: "Athena's AI model isn't set up yet." }, 503);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Expected a JSON body.' }, 400);
		}
		const parsed = PickRequest.safeParse(body);
		if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);

		const req = parsed.data;
		const usage = deps.usage ?? null;
		const entry = (status: number, by: string, outcome: PickOutcome | null, ms: number, error: string | null) => {
			const tokens = outcome?.usage ?? NO_USAGE;
			usage?.record({
				viewerId: viewer.id,
				viewer: viewer.name,
				kind: req.kind,
				request: req.request,
				picks: outcome?.picks.length ?? 0,
				suggestions: outcome?.suggestions.length ?? 0,
				by,
				ms,
				status,
				error,
				inputTokens: tokens.input_tokens,
				outputTokens: tokens.output_tokens,
				cacheRead: tokens.cache_read_input_tokens ?? 0,
				cacheWrite: tokens.cache_creation_input_tokens ?? 0,
				cost: outcome ? cost(by, tokens) : 0,
			});
		};

		const limit = deps.dailyLimit ?? null;
		if (limit && usage && !viewer.owner && usage.usedToday(viewer.id) >= limit && !usage.repeats(viewer.id, req.request)) {
			entry(429, '', null, 0, 'over the daily limit');
			const times = limit === 1 ? 'once' : `${limit} times`;
			const whose = deps.ownerName ? `${deps.ownerName}'s` : 'this';
			return c.json({ error: `You've used Describe It ${times} today on ${whose} Athena. It resets at midnight.` }, 429);
		}

		const started = Date.now();
		try {
			const { outcome, by } = await answer(req);
			const { picks, suggestions, minimums, usage: tokens } = outcome;
			entry(200, by, outcome, Date.now() - started, null);
			log(
				`pick ${req.kind} "${req.request}" from ${req.titles.length}: ${picks.length}` +
					(req.suggest ? `, suggested ${suggestions.length} from ${req.discover?.length ?? 0} recent` : '') +
					` in ${Date.now() - started}ms by ${by} ` +
					`(in ${tokens.input_tokens}, cache read ${tokens.cache_read_input_tokens ?? 0}, ` +
					`cache write ${tokens.cache_creation_input_tokens ?? 0}, out ${tokens.output_tokens})`,
			);
			return c.json({ picks, suggestions, minimums });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = error instanceof PickError ? error.status : 502;
			entry(status, '', null, Date.now() - started, message);
			warn(`pick ${req.kind} "${req.request}" failed after ${Date.now() - started}ms: ${message}`);
			return c.json({ error: message }, status);
		}
	});

	return app;
}
