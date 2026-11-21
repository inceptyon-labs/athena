import Anthropic from '@anthropic-ai/sdk';
import { log, warn } from './log';
import { PlexGate } from './plex';
import { createApp } from './server';

const port = Number(process.env.PORT ?? 8800);
const model = process.env.ATHENA_MODEL || 'claude-haiku-5-5';
const apiKey = process.env.ANTHROPIC_API_KEY;

// One retry: a viewer is waiting on the other end.
const client = apiKey ? new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 }) : null;
if (!client) warn('ANTHROPIC_API_KEY is not set: suggestions answer 503');
const jevKey = process.env.TYPESAFE_API_KEY || null;

const plexURL = process.env.PLEX_URL?.replace(/\/+$/, '') || null;
const gate = plexURL ? new PlexGate(plexURL) : null;
if (!gate) warn('PLEX_URL is not set: anyone who can reach Athena can use it');
else void gate.machineIdentifier().then((id) => log(id ? `checking sign-ins against Plex ${id}` : `Plex at ${plexURL} hasn't answered yet`));

Bun.serve({ port, fetch: createApp({ client, model, jevKey, gate }).fetch, maxRequestBodySize: 4 * 1024 * 1024 });
log(`athena listening on :${port} with ${model}${jevKey ? ', library picks by Jev' : ''}`);
