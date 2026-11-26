import { join } from 'node:path';
import { JOBS, Runner } from './jobs';
import { Live } from './live';
import { log, warn } from './log';
import { createApp } from './server';
import { Sessions } from './sessions';
import { Settings } from './settings';
import { Usage } from './usage';
import { mountWeb } from './web';

// Settings hold API keys and the log holds what people typed: nothing Athena writes is readable by anyone else.
process.umask(0o077);

const port = Number(process.env.PORT ?? 8800);
const data = process.env.ATHENA_DATA || './data';
const live = new Live(new Settings(data));
const usage = new Usage(join(data, 'athena.db'));
const runner = new Runner(join(data, 'jobs.db'), JOBS, () => ({
	abs: live.abs,
	region: live.audibleRegion,
	auto: (id) => live.autoJobs.includes(id),
}));
runner.schedule();

const effective = live.effective;
if (!live.ai) warn(`no ${live.provider} model set up yet: suggestions answer 503`);
if (!live.gate) warn(`no Plex server chosen yet: open http://<this machine>:${port}/ to set Athena up`);
else void live.gate.machineIdentifier().then((id) => log(id ? `checking sign-ins against Plex ${id}` : `Plex at ${effective.plexURL} hasn't answered yet`));

const app = createApp(Object.assign(live, { usage }));
mountWeb(app, { live, usage, runner, sessions: new Sessions() });

Bun.serve({ port, fetch: app.fetch, maxRequestBodySize: 4 * 1024 * 1024 });
log(`athena listening on :${port} with ${live.provider} ${live.model || '(no model)'}${live.jevKey ? ', library picks by Jev' : ''}`);
