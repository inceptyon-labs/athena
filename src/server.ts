import type Anthropic from '@anthropic-ai/sdk';
import { Hono } from 'hono';
import { z } from 'zod';
import { log, warn } from './log';
import { PickError, PickRequest, pick, type PickOutcome } from './pick';

export interface Deps {
	client: Anthropic | null;
	model: string;
	/** Replaced in tests. */
	pick?: (client: Anthropic, model: string, req: PickRequest) => Promise<PickOutcome>;
}

export function createApp({ client, model, pick: runPick = pick }: Deps) {
	const app = new Hono();

	// `service` is how Ithaca recognises Mentor when it looks for it on the Plex server's address.
	app.get('/healthz', (c) => c.json({ ok: true, ready: client !== null, model, service: 'mentor' }));

	app.post('/v1/pick', async (c) => {
		if (!client) return c.json({ error: 'Mentor has no Anthropic API key yet.' }, 503);
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
			const { picks, suggestions, minimums, usage } = await runPick(client, model, req);
			log(
				`pick ${req.kind} "${req.request}" from ${req.titles.length}: ${picks.length}` +
					(req.suggest ? `, suggested ${suggestions.length} from ${req.discover?.length ?? 0} recent` : '') +
					` in ${Date.now() - started}ms ` +
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
