import type Anthropic from '@anthropic-ai/sdk';
import { Hono } from 'hono';
import { z } from 'zod';
import { pickWithJev } from './jev';
import { log, warn } from './log';
import { PickError, PickRequest, pick, type PickOutcome } from './pick';
import type { PlexGate } from './plex';

export interface Deps {
	client: Anthropic | null;
	model: string;
	/** TypeSafe's key. With it, library picks go to Jev and only suggestions to Claude. */
	jevKey?: string | null;
	/** Replaced in tests. */
	pick?: (client: Anthropic, model: string, req: PickRequest) => Promise<PickOutcome>;
	pickWithJev?: (key: string, req: PickRequest) => Promise<PickOutcome>;
	/** Checks callers against the Plex server. Without it (no PLEX_URL) anyone who can reach Athena may ask. */
	gate?: PlexGate | null;
}

export function createApp({
	client,
	model,
	jevKey = null,
	pick: runPick = pick,
	pickWithJev: runJev = pickWithJev,
	gate = null,
}: Deps) {
	const app = new Hono();

	/** Jev for picks from the library; Claude for suggestions, and when Jev fails. */
	async function answer(req: PickRequest): Promise<{ outcome: PickOutcome; by: string }> {
		if (jevKey && req.suggest === 0) {
			try {
				return { outcome: await runJev(jevKey, req), by: 'jev' };
			} catch (error) {
				if (!client) throw error;
				warn(`jev failed, asking Claude: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!client) throw new PickError('Athena has no Anthropic API key yet.', 503);
		return { outcome: await runPick(client, model, req), by: model };
	}

	// `service` is how Ithaca recognises Athena when it looks for it on the Plex server's address, and `server` is the
	// Plex server whose token Ithaca sends.
	app.get('/healthz', async (c) =>
		c.json({
			ok: true,
			ready: client !== null || jevKey !== null,
			model,
			jev: jevKey !== null,
			service: 'athena',
			server: gate ? await gate.machineIdentifier() : null,
		}),
	);

	app.post('/v1/pick', async (c) => {
		if (gate) {
			const token = c.req.header('X-Plex-Token');
			let allowed = false;
			try {
				allowed = token ? await gate.allows(token) : false;
			} catch (error) {
				warn(`plex sign-in check failed: ${error instanceof Error ? error.message : String(error)}`);
				return c.json({ error: "Athena couldn't reach Plex to check your sign-in. Try again in a minute." }, 502);
			}
			if (!allowed) return c.json({ error: 'Athena only answers people with access to its Plex server.' }, 401);
		}
		if (!client && !jevKey) return c.json({ error: 'Athena has no API key yet.' }, 503);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Expected a JSON body.' }, 400);
		}
		const parsed = PickRequest.safeParse(body);
		if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);

		const req = parsed.data;
		const started = Date.now();
		try {
			const { outcome, by } = await answer(req);
			const { picks, suggestions, minimums, usage } = outcome;
			log(
				`pick ${req.kind} "${req.request}" from ${req.titles.length}: ${picks.length}` +
					(req.suggest ? `, suggested ${suggestions.length} from ${req.discover?.length ?? 0} recent` : '') +
					` in ${Date.now() - started}ms by ${by} ` +
					`(in ${usage.input_tokens}, cache read ${usage.cache_read_input_tokens ?? 0}, ` +
					`cache write ${usage.cache_creation_input_tokens ?? 0}, out ${usage.output_tokens})`,
			);
			return c.json({ picks, suggestions, minimums });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warn(`pick ${req.kind} "${req.request}" failed after ${Date.now() - started}ms: ${message}`);
			return c.json({ error: message }, error instanceof PickError ? error.status : 502);
		}
	});

	return app;
}
