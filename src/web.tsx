import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { raw } from 'hono/html';
import type { Child, FC } from 'hono/jsx';
import { absBase, Audiobookshelf, type AbsUser } from './abs';
import { listModels } from './compat';
import type { Run, RunItem, Runner } from './jobs';
import { type Live, makeAI } from './live';
import { warn } from './log';
import { PickRequest } from './pick';
import type { Server } from './plex';
import { cost, listPrice, perDescribeIt, TYPICAL } from './prices';
import {
	isProvider,
	type KeyName,
	keyName,
	localBase,
	type Model,
	modelName,
	PROVIDERS,
	type Provider,
	type ProviderId,
	providerOf,
} from './providers';
import { hasFfmpeg } from './clips';
import type { Heard } from './jobs/audio-titles';
import { AUDIBLE_REGIONS, type Effective, mask } from './settings';
import { SCRIBE_MODEL, whisperModel, whisperName } from './speech';
import { publicAddress, qrSVG, shareLink } from './share';
import type { Session, Sessions } from './sessions';
import type { Entry, Usage } from './usage';

/**
 * The web UI on Athena's own port: sign in with Plex, settings for the Plex server's owner, the status page, and for
 * everyone else with access, their own use today.
 */
export interface Web {
	live: Live;
	usage: Usage;
	runner: Runner;
	sessions: Sessions;
	now?: () => number;
}

const SESSION = 'athena_session';
const PIN = 'athena_pin';

/** owner: owns the Plex server. setup: nobody has chosen a server yet, so whoever signs in first sets Athena up. */
type Role = 'owner' | 'setup' | 'viewer' | 'none';

const https = (c: Context) =>
	(c.req.header('X-Forwarded-Proto') ?? new URL(c.req.url).protocol.replace(':', '')).split(',')[0]?.trim() === 'https';

function origin(c: Context) {
	const host = c.req.header('X-Forwarded-Host') ?? c.req.header('Host') ?? new URL(c.req.url).host;
	return `${https(c) ? 'https' : 'http'}://${host.split(',')[0]?.trim()}`;
}

/** A form posted from another site never gets through, behind a reverse proxy or not. */
function sameSite(c: Context) {
	if (c.req.header('Sec-Fetch-Site') === 'cross-site') return false;
	const from = c.req.header('Origin');
	if (!from || from === 'null') return true;
	const host = c.req.header('X-Forwarded-Host') ?? c.req.header('Host');
	try {
		return new URL(from).host === host?.split(',')[0]?.trim();
	} catch {
		return false;
	}
}

/** About what a Describe It costs, in cents while it's under a dollar. */
function cents(dollars: number) {
	if (dollars >= 1) return `$${dollars.toFixed(2)}`;
	if (dollars < 0.0001) return '<0.01¢';
	if (dollars < 0.001) return `${(dollars * 100).toFixed(2)}¢`;
	return dollars < 0.01 ? `${(dollars * 100).toFixed(1)}¢` : `${Math.round(dollars * 100)}¢`;
}

/** A list price per million tokens. */
const perMillion = (dollars: number) => (Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`);

/** What a Describe It is assumed to send, for the estimates: the log's average once it has some. */
interface Estimate {
	prompts: { picks: number; suggestions: number };
	/** The prompt size came from this Athena's own requests. */
	measured: boolean;
	jev: boolean;
}

function money(dollars: number) {
	if (dollars === 0) return '$0';
	if (dollars < 0.01) return '<$0.01';
	return `$${dollars.toFixed(2)}`;
}

function duration(ms: number) {
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function when(at: number, now: number) {
	const time = new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	const day = new Date(at).toDateString() === new Date(now).toDateString();
	return day ? time : `${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

function result(entry: Entry) {
	if (entry.status === 0) return 'Answering…';
	if (entry.status === 429) return 'Over the daily limit';
	if (entry.status !== 200) return entry.error ?? `Failed (${entry.status})`;
	const parts = [];
	if (entry.picks || !entry.suggestions) parts.push(`${entry.picks} ${entry.picks === 1 ? 'pick' : 'picks'}`);
	if (entry.suggestions) parts.push(`${entry.suggestions} ${entry.suggestions === 1 ? 'suggestion' : 'suggestions'}`);
	return parts.join(', ');
}

const Layout: FC<{
	title: string;
	signedIn?: Session | null;
	nav?: 'status' | 'share' | 'settings' | 'automations';
	/** Shows Automations in the menu: only once Audiobookshelf is connected. */
	automations?: boolean;
	/** Reloads the page every so many seconds, while a job runs. */
	refresh?: number;
	bare?: boolean;
	children: Child;
}> = ({ title, signedIn, nav, automations, refresh, bare, children }) => (
	<>
		{raw('<!doctype html>')}
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<meta name="robots" content="noindex" />
				{refresh && <meta http-equiv="refresh" content={String(refresh)} />}
				<title>{title === 'Athena' ? 'Athena' : `${title} · Athena`}</title>
				<link rel="icon" href="/icon.svg" type="image/svg+xml" />
				<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
				<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
				<link rel="stylesheet" href="/app.css" />
				<script src="/app.js" defer />
			</head>
			<body>
				{!bare && (
					<header class="bar">
						<div class="bar-inner">
							<a class="brand" href="/">
								<img src="/mark.svg" alt="" width="26" height="26" />
								<span>Athena</span>
							</a>
							{nav && (
								<nav aria-label="Main">
									<a href="/" aria-current={nav === 'status' ? 'page' : undefined}>
										Status
									</a>
									<a href="/share" aria-current={nav === 'share' ? 'page' : undefined}>
										Share
									</a>
									{automations && (
										<a href="/automations" aria-current={nav === 'automations' ? 'page' : undefined}>
											Automations
										</a>
									)}
									<a href="/settings" aria-current={nav === 'settings' ? 'page' : undefined}>
										Settings
									</a>
								</nav>
							)}
							{signedIn && (
								<form method="post" action="/signout" class="who">
									<span class="who-name">{signedIn.name}</span>
									<button type="submit" class="quiet">
										Sign out
									</button>
								</form>
							)}
						</div>
					</header>
				)}
				<main>{children}</main>
			</body>
		</html>
	</>
);

const Note: FC<{ title: string; children: Child; signedIn?: Session | null }> = ({ title, children, signedIn }) => (
	<Layout title={title} signedIn={signedIn}>
		<section class="note">
			<h1>{title}</h1>
			{children}
		</section>
	</Layout>
);

export function mountWeb(app: Hono, web: Web) {
	const { live, usage, runner, sessions } = web;
	const now = web.now ?? Date.now;

	const files = ['app.css', 'app.js', 'icon.svg', 'mark.svg', 'favicon-32.png', 'apple-touch-icon.png'];
	for (const file of [...files, 'favicon.ico']) {
		const source = new URL(`../public/${file === 'favicon.ico' ? 'favicon-32.png' : file}`, import.meta.url);
		app.get(`/${file}`, () => new Response(Bun.file(source), { headers: { 'Cache-Control': 'public, max-age=3600' } }));
	}

	app.use('*', async (c, next) => {
		await next();
		c.res.headers.set('X-Content-Type-Options', 'nosniff');
		if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
			c.res.headers.set('Cache-Control', 'no-store');
			c.res.headers.set('X-Frame-Options', 'DENY');
			c.res.headers.set('Referrer-Policy', 'same-origin');
			// No form-action: signing in sends the browser on to app.plex.tv.
			c.res.headers.set(
				'Content-Security-Policy',
				"default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
			);
		}
	});

	const session = (c: Context) => sessions.get(getCookie(c, SESSION));

	/** The servers this person reaches, asked of plex.tv at most once a minute. Null once Plex no longer knows the token. */
	async function serversOf(s: Session): Promise<Server[] | null> {
		if (s.servers && now() - s.servers.at < 60_000) return s.servers.list;
		const list = await live.plexTV.servers(s.token);
		if (list) s.servers = { at: now(), list };
		return list;
	}

	async function roleOf(s: Session): Promise<{ role: Role; servers: Server[]; machine: string | null } | null> {
		const servers = await serversOf(s);
		if (!servers) return null;
		const gate = live.gate;
		if (!gate) return { role: 'setup', servers, machine: null };
		const machine = await gate.machineIdentifier();
		const server = servers.find((candidate) => candidate.id === machine);
		// Once the owner who set Athena up is known, anyone else plex.tv says owns the server is a viewer.
		const owner = server?.owned && (live.ownerId === null || live.ownerId === s.accountId);
		return { role: owner ? 'owner' : server ? 'viewer' : 'none', servers, machine };
	}

	function serverName(servers: Server[], machine: string | null) {
		return servers.find((server) => server.id === machine)?.name ?? live.effective.server?.name ?? 'the Plex server';
	}

	/** Finds who is signed in and what they may do, or answers for them: the sign-in page, or Plex's error. */
	async function who(c: Context) {
		const s = session(c);
		if (!s) return { page: c.html(<SignIn />) };
		try {
			const role = await roleOf(s);
			if (!role) {
				sessions.delete(getCookie(c, SESSION));
				deleteCookie(c, SESSION, { path: '/' });
				return { page: c.html(<SignIn />) };
			}
			if (role.role === 'owner' && (live.ownerId === null || live.ownerToken !== s.token)) {
				// Set up before Athena kept the owner's account or token: it learns them on the owner's first visit, and
				// the token again after each sign-in, since plex.tv makes a new one each time.
				live.settings.save({ ownerId: s.accountId, ownerToken: s.token });
				live.refresh();
			}
			return { s, ...role };
		} catch (error) {
			warn(`plex.tv check for the web UI failed: ${error instanceof Error ? error.message : String(error)}`);
			return {
				page: c.html(
					<Note title="Plex didn't answer" signedIn={s}>
						<p>Athena couldn't ask plex.tv who you are. Try again in a minute.</p>
					</Note>,
					502,
				),
			};
		}
	}

	const SignIn: FC = () => (
		<Layout title="Athena" bare>
			<section class="signin">
				<img src="/icon.svg" alt="" width="88" height="88" class="signin-icon" />
				<h1>Athena</h1>
				<p class="lede">Describe It for Ithaca, answered by the AI model you choose, from your own Plex library.</p>
				<form method="post" action="/signin">
					<button type="submit" class="primary wide">
						Sign in with Plex
					</button>
				</form>
				<p class="hint">
					Athena runs next to Plex and Seerr. The Plex server's owner sets it up here; anyone the server is shared
					with can sign in to see their own use.
				</p>
			</section>
		</Layout>
	);

	app.post('/signin', async (c) => {
		if (!sameSite(c)) return c.text('Forbidden', 403);
		try {
			const pin = await live.plexTV.pin();
			setCookie(c, PIN, String(pin.id), {
				path: '/',
				httpOnly: true,
				sameSite: 'Lax',
				secure: https(c),
				maxAge: 15 * 60,
			});
			return c.redirect(live.plexTV.authURL(pin.code, `${origin(c)}/signin/done`), 303);
		} catch (error) {
			warn(`plex sign-in failed to start: ${error instanceof Error ? error.message : String(error)}`);
			return c.html(
				<Note title="Plex didn't answer">
					<p>Athena couldn't start a Plex sign-in. Try again in a minute.</p>
					<p>
						<a href="/">Back</a>
					</p>
				</Note>,
				502,
			);
		}
	});

	app.get('/signin/done', async (c) => {
		const pin = Number(getCookie(c, PIN));
		if (!pin) return c.redirect('/', 303);
		let token: string | null = null;
		try {
			token = await live.plexTV.token(pin);
		} catch (error) {
			warn(`plex sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const tries = Number(c.req.query('try') ?? 0);
		if (!token) {
			if (tries >= 30) {
				deleteCookie(c, PIN, { path: '/' });
				return c.html(
					<Note title="Sign-in didn't finish">
						<p>Plex didn't confirm the sign-in.</p>
						<form method="post" action="/signin">
							<button type="submit" class="primary">
								Try again
							</button>
						</form>
					</Note>,
				);
			}
			return c.html(
				<Layout title="Signing in">
					{raw(`<meta http-equiv="refresh" content="2;url=/signin/done?try=${tries + 1}">`)}
					<section class="note">
						<h1>Waiting for Plex</h1>
						<p>Approve the sign-in on Plex's page, and this page carries on by itself.</p>
					</section>
				</Layout>,
			);
		}
		deleteCookie(c, PIN, { path: '/' });
		try {
			const account = await live.plexTV.account(token);
			if (!account) return c.redirect('/', 303);
			const id = sessions.create({ accountId: account.id, name: account.name, token });
			setCookie(c, SESSION, id, {
				path: '/',
				httpOnly: true,
				sameSite: 'Lax',
				secure: https(c),
				maxAge: 30 * 86_400,
			});
			return c.redirect('/', 303);
		} catch (error) {
			warn(`plex account lookup failed: ${error instanceof Error ? error.message : String(error)}`);
			return c.html(
				<Note title="Plex didn't answer">
					<p>Athena couldn't ask plex.tv who you are. Try again in a minute.</p>
				</Note>,
				502,
			);
		}
	});

	app.post('/signout', (c) => {
		if (!sameSite(c)) return c.text('Forbidden', 403);
		sessions.delete(getCookie(c, SESSION));
		deleteCookie(c, SESSION, { path: '/' });
		return c.redirect('/', 303);
	});

	/** Whether Athena can answer, and what to do when it can't. */
	function readiness(servers: Server[], machine: string | null) {
		const effective = live.effective;
		if (!live.gate)
			return { state: 'off', title: 'Not set up', detail: 'Choose your Plex server in Settings.' } as const;
		if (!machine)
			return {
				state: 'off',
				title: 'Not ready',
				detail: `Plex at ${effective.plexURL ?? 'PLEX_URL'} isn't answering, so Athena can't tell who may use it.`,
			} as const;
		const name = serverName(servers, machine);
		const provider = providerOf(live.provider);
		const needs =
			provider.id === 'local'
				? "add your local model's address and name in Settings."
				: `add your ${provider.name} API key in Settings.`;
		if (!live.ai && !live.jevKey)
			return { state: 'off', title: 'Not ready', detail: `To answer, ${needs}` } as const;
		if (!live.ai)
			return {
				state: 'partial',
				title: 'Partly ready',
				detail: `Library picks for ${name} come from Jev. For suggestions, ${needs}`,
			} as const;
		return {
			state: 'on',
			title: 'Ready',
			detail: `Answering for ${name} with ${modelName(live.ai.by)}${live.jevKey ? '. Library picks by Jev' : ''}.`,
		} as const;
	}

	app.get('/', async (c) => {
		const found = await who(c);
		if ('page' in found) return found.page;
		const { s, role, servers, machine } = found;
		if (role === 'setup') return c.redirect('/settings', 303);
		const name = serverName(servers, machine);
		if (role === 'none')
			return c.html(
				<Note title="No access" signedIn={s}>
					<p>
						Your Plex account, {s.name}, isn't one {name} is shared with, so this Athena doesn't answer it. Ask the
						server's owner to share their library with you in Plex.
					</p>
				</Note>,
			);
		if (role === 'viewer') {
			const used = usage.usedToday(s.accountId);
			const limit = live.dailyLimit;
			return c.html(
				<Note title={`Athena on ${name}`} signedIn={s}>
					<p>Athena answers Describe It in Ithaca for you, from {name}'s library.</p>
					<p class="figure">
						{limit ? (
							<>
								<strong>{used}</strong> of {limit} Describe Its today
							</>
						) : (
							<>
								<strong>{used}</strong> Describe {used === 1 ? 'It' : 'Its'} today, with no daily limit
							</>
						)}
					</p>
					<p class="hint">Settings are for {name}'s owner.</p>
				</Note>,
			);
		}

		const ready = readiness(servers, machine);
		const totals = usage.totals();
		const recent = usage.recent(50);
		const people = usage.byPerson();
		const limit = live.dailyLimit;
		return c.html(
			<Layout title="Status" signedIn={s} nav="status" automations={live.abs !== null}>
				<section class={`state state-${ready.state}`} aria-live="polite">
					<span class="dot" aria-hidden="true" />
					<div>
						<h1>{ready.title}</h1>
						<p>
							{ready.detail}
							{ready.state === 'off' && (
								<>
									{' '}
									<a href="/settings">Open Settings</a>
								</>
							)}
						</p>
					</div>
				</section>

				<dl class="totals">
					<div>
						<dt>Today</dt>
						<dd>
							{totals.today} <span>Describe {totals.today === 1 ? 'It' : 'Its'}</span>
						</dd>
					</div>
					<div>
						<dt>This month</dt>
						<dd>
							{totals.month} <span>Describe {totals.month === 1 ? 'It' : 'Its'}</span>
						</dd>
					</div>
					<div>
						<dt>Spend this month</dt>
						<dd>
							{money(totals.spendMonth)}
							{totals.unpriced ? '+' : ''} <span>estimated</span>
						</dd>
					</div>
					<div>
						<dt>Daily limit</dt>
						<dd>
							{limit ? (
								<>
									{limit} <span>a day each</span>
								</>
							) : (
								<span class="none">None</span>
							)}
						</dd>
					</div>
				</dl>

				{people.length > 0 && (
					<section class="people">
						<h2>By person</h2>
						<ul>
							{people.map((person) => {
								const you = person.viewerId === s.accountId;
								const full = !you && limit !== null && person.today >= limit;
								return (
									<li class={full ? 'full' : undefined}>
										<span class="person">
											{person.viewer ?? 'Unknown'}
											{you && <span class="you">you, no limit</span>}
										</span>
										<span class="figures">
											<span class="count today">
												<strong>{person.today}</strong>
												{!you && limit ? ` of ${limit}` : ''} today
											</span>
											<span class="count">
												<strong>{person.month}</strong> this month,{' '}
												<strong>
													{money(person.spend)}
													{person.unpriced ? '+' : ''}
												</strong>
											</span>
										</span>
									</li>
								);
							})}
						</ul>
					</section>
				)}

				<section class="recent">
					<h2>Recent requests</h2>
					{recent.length === 0 ? (
						<p class="empty">
							Nothing yet. Ask for something in Ithaca's Describe It, and it shows up here with who asked, the answer,
							the model and how long it took.
						</p>
					) : (
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th scope="col">When</th>
										<th scope="col">Who</th>
										<th scope="col">Request</th>
										<th scope="col">Answer</th>
										<th scope="col">By</th>
										<th scope="col" class="num">
											Took
										</th>
									</tr>
								</thead>
								<tbody>
									{recent.map((entry) => (
										<tr class={entry.status === 200 || entry.status === 0 ? undefined : 'failed'}>
											<td class="when">{when(entry.at, now())}</td>
											<td class="viewer">{entry.viewer ?? 'Unknown'}</td>
											<td class="request">
												<span class="kind">{entry.kind === 'show' ? 'TV' : 'Film'}</span> {entry.request}
											</td>
											<td class="answer">{result(entry)}</td>
											<td class="by">{entry.by ? modelName(entry.by) : ''}</td>
											<td class="num took">{entry.status === 429 || entry.status === 0 ? '' : duration(entry.ms)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</section>
			</Layout>,
		);
	});

	app.get('/share', async (c) => {
		const found = await who(c);
		if ('page' in found) return found.page;
		const { s, role } = found;
		if (role === 'setup') return c.redirect('/settings', 303);
		if (role !== 'owner') return c.redirect('/', 303);
		const address = live.effective.publicURL;
		return c.html(
			<Layout title="Share" signedIn={s} nav="share" automations={live.abs !== null}>
				<div class="page-head">
					<h1>Share with friends</h1>
					<p class="lede">
						Your household's Ithaca finds Athena on port 8800 by itself. Friends who use your Plex from outside your
						home need its public address, the way they reach your Seerr.
					</p>
				</div>
				{address ? (
					<ShareTo address={address} />
				) : (
					<section class="note">
						<p>
							Athena is home-only until it has a public address: an HTTPS address in front of port 8800, from a reverse
							proxy with a certificate. Add it in Settings, and this page gives you a link, a QR code and the address to
							type on Apple TV.
						</p>
						<p>
							<a href="/settings#publicURL">Add a public address</a>
						</p>
					</section>
				)}
			</Layout>,
		);
	});

	/** The link, its QR code and the address to type, for a friend's iPhone, iPad or Apple TV. */
	const ShareTo: FC<{ address: string }> = ({ address }) => {
		const link = shareLink(address);
		return (
			<div class="share">
				<section class="share-phone">
					<div class="qr">{raw(qrSVG(link))}</div>
					<div class="share-text">
						<h2>iPhone and iPad</h2>
						<p class="hint">Scanned with the camera, the code opens Ithaca with Athena's address filled in.</p>
						<label class="label" for="share-link">
							Or send the link
						</label>
						<div class="copy">
							<input id="share-link" type="text" value={link} readonly spellcheck={false} />
							<button type="button" class="secondary" data-copy="share-link" hidden>
								Copy
							</button>
						</div>
					</div>
				</section>
				<section class="share-tv">
					<h2>Apple TV</h2>
					<p class="hint">In Ithaca, under Settings → Athena, type:</p>
					<p class="address">{address}</p>
				</section>
				<p class="hint share-after">
					Ithaca saves the address and asks before the first request whether Describe It may use Athena. Friends'
					requests are on your {providerOf(live.provider).id === 'local' ? 'own machine' : `${providerOf(live.provider).name} bill`};{' '}
					{live.dailyLimit ? (
						<>
							each gets {live.dailyLimit} Describe {live.dailyLimit === 1 ? 'It' : 'Its'} a day. <a href="/settings#dailyLimit">Change the limit</a>
						</>
					) : (
						<>
							there's no daily limit. <a href="/settings#dailyLimit">Set one</a>
						</>
					)}
				</p>
			</div>
		);
	};

	/** The owner, signed in, or the page to show instead. */
	async function owner(c: Context) {
		const found = await who(c);
		if ('page' in found) return { page: found.page };
		if (found.role !== 'owner') return { page: c.redirect('/', 303) };
		return { s: found.s };
	}

	/** "Names found: 12, Different length: 3" for a run, in the job's order. */
	function tally(run: Run) {
		const job = runner.job(run.job);
		const parts = (job?.outcomes ?? []).flatMap((outcome) =>
			run.counts[outcome.id] ? [`${outcome.label}: ${run.counts[outcome.id]}`] : [],
		);
		return parts.length ? parts.join(', ') : 'Nothing to fix';
	}

	const books = (n: number) => `${n} ${n === 1 ? 'book' : 'books'}`;

	/** A run's page, in a sentence or two: what it looked at, what it found, and whether anything changed. */
	function summary(run: Run, items: RunItem[]) {
		if (run.status === 'running') return `${status(run)}…`;
		if (run.status === 'failed') return `${status(run)}.`;
		const at = `${new Date(run.started).toDateString() === new Date(now()).toDateString() ? 'at' : 'on'} ${when(run.started, now())}`;
		const unchecked = run.total - run.checked;
		const stopped = run.status === 'stopped' ? ` It was stopped before the end${unchecked > 0 ? `, with ${books(unchecked)} not looked at` : ''}.` : '';
		const count = (outcome: string) => items.filter((item) => item.outcome === outcome).length;
		if (run.job === 'audio-titles') {
			if (run.dryRun) {
				const readable = count('readable');
				const audible = count('audible');
				return `Checked ${books(run.checked)} ${at}. ${readable} ${readable === 1 ? 'has' : 'have'} only numbered chapters that no Audible store names${audible ? `, and ${audible} more Audible can name` : ''}. Nothing was read or changed.${stopped}`;
			}
			const waiting = count('proposed') + count('numbers');
			return `Read ${books(run.checked)} ${at}. ${waiting ? `${books(waiting)} ${waiting === 1 ? 'waits' : 'wait'} for your approval below; nothing is renamed until you approve.` : 'None waits for approval.'}${stopped}`;
		}
		if (run.dryRun) {
			const named = Math.max(0, run.checked - items.length);
			const ready = count('ready');
			const cant = items.length - ready;
			const found =
				items.length === 0
					? ''
					: ` ${books(items.length)} ${items.length === 1 ? 'has' : 'have'} only numbered chapters: ${ready} can be renamed${cant ? `, ${cant} can’t (why below)` : ''}.`;
			return `Checked ${books(run.checked)} with an ASIN ${at}. ${named} already ${named === 1 ? 'has' : 'have'} chapter names.${found} Nothing was changed.${stopped}`;
		}
		const renamed = count('renamed');
		const left = items.length - renamed;
		const who = run.trigger === 'schedule' ? 'Ran by itself' : 'Ran';
		return `${who} ${at}, looking at ${books(run.checked)}: renamed ${renamed}${left ? `, left ${left} alone (why below)` : ''}.${stopped}`;
	}

	/** What Titles from the audio reads and writes with, or what it still needs. */
	function titlesReady() {
		const needs = [
			!hasFfmpeg() && 'the speech image (ATHENA_TARGET=speech), which has ffmpeg',
			!live.speech && 'speech to text, chosen in Settings',
			!live.ai?.titles && 'an AI model, set up in Settings',
		].filter(Boolean);
		if (needs.length) return `Checking works now. Reading needs ${needs.join(', ')}.`;
		return `Reads with ${live.speech?.name} and writes the titles with ${live.ai?.by}.`;
	}

	function status(run: Run) {
		if (run.status === 'running') return run.total ? `Checking ${run.checked} of ${run.total}` : 'Starting';
		if (run.status === 'failed') return `Failed: ${run.error ?? 'unknown error'}`;
		if (run.status === 'stopped') return 'Stopped';
		return tally(run);
	}

	app.get('/automations', async (c) => {
		const found = await owner(c);
		if ('page' in found) return found.page;
		const abs = live.abs;
		if (!abs) return c.redirect('/settings#abs', 303);
		let account: AbsUser | null = null;
		let unreachable: string | null = null;
		try {
			account = await abs.me();
		} catch (error) {
			unreachable = error instanceof Error ? error.message : String(error);
		}
		const running = runner.running;
		const runs = runner.runs(20);
		const problem = RUN_PROBLEMS.get(c.req.query('problem') ?? '') ?? null;
		return c.html(
			<Layout title="Automations" signedIn={found.s} nav="automations" automations refresh={running ? 3 : undefined}>
				<div class="page-head">
					<h1>Automations</h1>
					<p class="lede">
						Jobs that tidy your Audiobookshelf library, run here with the keys kept here. Every app, Siren
						included, sees what they change.
					</p>
				</div>
				{problem && (
					<p class="banner error" role="alert">
						{problem}
					</p>
				)}
				<section class={`state state-${account ? (account.canUpdate ? 'on' : 'partial') : 'off'}`} aria-live="polite">
					<span class="dot" aria-hidden="true" />
					<div>
						<h2>{account ? 'Connected to Audiobookshelf' : "Audiobookshelf isn't answering"}</h2>
						<p>
							{account
								? `As ${account.username} at ${abs.url}.${account.canUpdate ? '' : " This user can't update books, so jobs can only check."}`
								: unreachable}{' '}
							<a href="/settings#abs">Settings</a>
						</p>
					</div>
				</section>

				{runner.jobs.map((job) => {
					const last = runner.runs(1, job.id)[0];
					const mine = running?.job === job.id;
					const auto = live.autoJobs.includes(job.id);
					return (
						<section class="recent job">
							<h2>{job.title}</h2>
							<p class="hint">{job.summary}</p>
							<p>
								{mine && running
									? `${status(running)}…`
									: last
										? `${last.dryRun ? 'Last checked' : 'Last run'} ${when(last.started, now())}: ${status(last)}.`
										: 'Not run yet.'}{' '}
								{last && !mine && <a href={`/automations/runs/${last.id}`}>See the books</a>}
							</p>
							{job.scheduled !== false && (
								<>
									<form method="post" action={`/automations/${job.id}/auto`} class="actions">
										<label class="remove">
											<input type="checkbox" name="auto" value="1" checked={auto} /> Run by itself every hour
										</label>
										<button type="submit" class="secondary small">
											Save
										</button>
									</form>
									<p class="hint">
										{auto
											? 'On: each hour it looks at books added or changed since the last run, and renames those that fit.'
											: 'Off: it runs only when you press Check now, and changes nothing until you rename from the results.'}
									</p>
								</>
							)}
							{job.id === 'audio-titles' && <p class="hint">{titlesReady()}</p>}
							<div class="actions">
								{mine ? (
									<form method="post" action="/automations/stop">
										<button type="submit" class="secondary">
											Stop
										</button>
									</form>
								) : (
									<form method="post" action={`/automations/${job.id}/run`}>
										<button type="submit" class="primary" disabled={running !== null || !account}>
											Check now
										</button>
									</form>
								)}
								<span class="hint">{job.checks}</span>
							</div>
						</section>
					);
				})}

				{runs.length > 0 && (
					<section class="recent">
						<h2>Recent runs</h2>
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th scope="col">When</th>
										<th scope="col">Job</th>
										<th scope="col">Result</th>
									</tr>
								</thead>
								<tbody>
									{runs.map((run) => (
										<tr class={run.status === 'failed' ? 'failed' : undefined}>
											<td class="when">{when(run.started, now())}</td>
											<td>
												<a href={`/automations/runs/${run.id}`}>{runner.job(run.job)?.title ?? run.job}</a>
												{run.dryRun && (
													<>
														{' '}
														<span class="kind">Check</span>
													</>
												)}
											</td>
											<td>{status(run)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>
				)}
			</Layout>,
		);
	});

	app.get('/automations/runs/:id', async (c) => {
		const found = await owner(c);
		if ('page' in found) return found.page;
		const run = runner.run(Number(c.req.param('id')));
		if (!run) return c.redirect('/automations', 303);
		const job = runner.job(run.job);
		const items = runner.items(run.id);
		const problem = RUN_PROBLEMS.get(c.req.query('problem') ?? '') ?? null;
		const next = job?.next && run.dryRun ? job.next : null;
		const busy = runner.running !== null;
		return c.html(
			<Layout
				title={job?.title ?? 'Run'}
				signedIn={found.s}
				nav="automations"
				automations={live.abs !== null}
				refresh={run.status === 'running' ? 3 : undefined}
			>
				<div class="page-head">
					<h1>{job?.title ?? run.job}</h1>
					<p class="lede">
						{summary(run, items)} <a href="/automations">Automations</a>
					</p>
				</div>
				{problem && (
					<p class="banner error" role="alert">
						{problem}
					</p>
				)}
				{items.length === 0 && run.status !== 'running' && (
					<p class="empty">Every book it checked is fine as it is.</p>
				)}
				{(job?.outcomes ?? []).map((outcome) => {
					const group = items.filter((item) => item.outcome === outcome.id);
					if (group.length === 0) return null;
					return (
						<section class="recent">
							<h2>
								{outcome.label} <span class="optional">{group.length}</span>
							</h2>
							{outcome.note && <p class="hint">{outcome.note}</p>}
							{outcome.action && (
								<p class="hint">
									<strong>What you can do:</strong> {outcome.action}
								</p>
							)}
							<div class="table-wrap">
								<table>
									<tbody>
										{group.map((item) => (
											<tr>
												<td class="request">
													{live.abs ? (
														<a href={`${live.abs.url}/item/${encodeURIComponent(item.item)}`} target="_blank" rel="noreferrer">
															{item.title}
														</a>
													) : (
														item.title
													)}
												</td>
												<td class="answer">
													{item.detail}
													{Array.isArray(item.after) && (item.after as Heard[]).some((chapter) => 'heard' in chapter) && (
														<Proposal before={item.before as string[]} after={item.after as Heard[]} />
													)}
												</td>
												{next?.from === outcome.id && (
													<td class="num">
														<form method="post" action={`/automations/runs/${run.id}/next`}>
															<input type="hidden" name="item" value={item.item} />
															<button type="submit" class="secondary small" disabled={busy}>
																{next.verb}
															</button>
														</form>
													</td>
												)}
												{job?.approvable?.includes(outcome.id) && (
													<td class="num">
														<form method="post" action={`/automations/runs/${run.id}/decide`} class="decide">
															<input type="hidden" name="item" value={item.item} />
															<button type="submit" name="approve" value="1" class="primary small">
																Approve
															</button>
															<button type="submit" name="approve" value="0" class="secondary small">
																Reject
															</button>
														</form>
													</td>
												)}
												{job?.undoable?.includes(outcome.id) && (
													<td class="num">
														{item.undone ? (
															<span class="kind">Undone</span>
														) : (
															<form method="post" action={`/automations/runs/${run.id}/undo`}>
																<input type="hidden" name="item" value={item.item} />
																<button type="submit" class="secondary small">
																	Undo
																</button>
															</form>
														)}
													</td>
												)}
											</tr>
										))}
									</tbody>
								</table>
							</div>
							{next?.from === outcome.id && (
								<form method="post" action={`/automations/runs/${run.id}/next`} class="actions">
									<button type="submit" class="primary" disabled={busy}>
										{next.verb} {group.length === 1 ? 'this book' : `these ${group.length} books`}
									</button>
									<span class="hint">{next.hint}</span>
								</form>
							)}
						</section>
					);
				})}
			</Layout>,
		);
	});

	app.post('/automations/:job/run', async (c) => {
		if (!sameSite(c)) return c.text('Forbidden', 403);
		const found = await owner(c);
		if ('page' in found) return found.page;
		// Only checks for now: no job writes to Audiobookshelf yet.
		const started = runner.start(c.req.param('job'), { dryRun: true });
		return c.redirect(typeof started === 'number' ? '/automations' : `/automations?problem=${started}`, 303);
	});

	/** What a check leads to, for one of its books or all of them: renaming them, or reading their audio. */
	app.post('/automations/runs/:id/next', async (c) => {
		if (!sameSite(c)) return c.text('Forbidden', 403);
		const found = await owner(c);
		if ('page' in found) return found.page;
		const run = runner.run(Number(c.req.param('id')));
		const from = run ? runner.job(run.job)?.next?.from : undefined;
		if (!run?.dryRun || !from) return c.redirect('/automations', 303);
		const form = await c.req.parseBody();
		const only = typeof form.item === 'string' ? form.item : null;
		// What the check showed, so the next run takes just that and leaves any book that changed since.
		const plan = Object.fromEntries(
			runner
				.items(run.id)
				.flatMap((item) => (item.outcome === from && (!only || item.item === only) ? [[item.item, { before: item.before, after: item.after }]] : [])),
		);
		if (Object.keys(plan).length === 0) return c.redirect(`/automations/runs/${run.id}`, 303);
		const started = runner.start(run.job, { dryRun: false, plan });
		return c.redirect(typeof started === 'number' ? `/automations/runs/${started}` : `/automations/runs/${run.id}?problem=${started}`, 303);
	});

	app.post('/automations/runs/:id/undo', async (c) => {
		if (!sameSite(c)) return c.text('Forbidden', 403);
		const found = await owner(c);
		if ('page' in found) return found.page;
		const id = Number(c.req.param('id'));
		const form = await c.req.parseBody();
		const item = typeof form.item === 'string' ? form.item : '';
		let problem: string | null;
		try {
			problem = await runner.undo(id, item);
		} catch (error) {
			warn(`undo in run ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
			problem = 'failed';
		}
		return c.redirect(problem ? `/automations/runs/${id}?problem=${problem}` : `/automations/runs/${id}`, 303);
	});

	/** The owner's Approve or Reject on one book a run holds for approval. */
	app.post('/automations/runs/:id/decide', async (c) => {
		if (!sameSite(c)) return c.text('Forbidden', 403);
		const found = await owner(c);
		if ('page' in found) return found.page;
		const id = Number(c.req.param('id'));
		const form = await c.req.parseBody();
		const item = typeof form.item === 'string' ? form.item : '';
		let problem: string | null;
		try {
			problem = await runner.decide(id, item, form.approve === '1');
		} catch (error) {
			warn(`approving in run ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
			problem = 'failed';
		}
		return c.redirect(problem ? `/automations/runs/${id}?problem=${problem}` : `/automations/runs/${id}`, 303);
	});

	app.post('/automations/:job/auto', async (c) => {
		if (!sameSite(c)) return c.text('Forbidden', 403);
		const found = await owner(c);
		if ('page' in found) return found.page;
		const job = runner.job(c.req.param('job'));
		if (!job) return c.redirect('/automations', 303);
		const form = await c.req.parseBody();
		const others = live.effective.autoJobs.filter((id) => id !== job.id);
		live.settings.save({ autoJobs: form.auto === '1' ? [...others, job.id] : others });
		live.refresh();
		return c.redirect('/automations', 303);
	});

	app.post('/automations/stop', async (c) => {
		if (!sameSite(c)) return c.text('Forbidden', 403);
		const found = await owner(c);
		if ('page' in found) return found.page;
		runner.stop();
		return c.redirect('/automations', 303);
	});

	app.get('/settings', async (c) => {
		const found = await who(c);
		if ('page' in found) return found.page;
		const { s, role, servers, machine } = found;
		if (role === 'viewer' || role === 'none') return c.redirect('/', 303);
		return c.html(
			<SettingsPage
				s={s}
				setup={role === 'setup'}
				servers={servers}
				machine={machine}
				saved={c.req.query('saved') !== undefined}
				problem={PROBLEMS.get(c.req.query('problem') ?? '') ?? null}
			/>,
		);
	});

	const SettingsPage: FC<{
		s: Session;
		setup: boolean;
		servers: Server[];
		machine: string | null;
		saved: boolean;
		problem: string | null;
	}> = ({ s, setup, servers, machine, saved, problem }) => {
		const effective = live.effective;
		const owned = servers.filter((server) => server.owned);
		const chosen = effective.server?.id ?? machine;
		const size = usage.promptSize();
		const estimate: Estimate = {
			prompts: size ? { picks: size, suggestions: size } : TYPICAL,
			measured: size !== null,
			jev: Boolean(effective.typesafeKey),
		};
		return (
			<Layout
				title={setup ? 'Set up' : 'Settings'}
				signedIn={s}
				nav={setup ? undefined : 'settings'}
				automations={live.abs !== null}
			>
				<div class="page-head">
					<h1>{setup ? 'Set up Athena' : 'Settings'}</h1>
					{setup && (
						<p class="lede">
							Athena runs next to Plex and Seerr. Choose your Plex server and an AI model; your household's Ithaca
							finds Athena on port 8800 by itself once it's ready.
						</p>
					)}
				</div>
				{problem && (
					<p class="banner error" role="alert">
						{problem}
					</p>
				)}
				<form method="post" action="/settings" class="settings">
					<fieldset>
						<legend>Plex server</legend>
						<p class="hint">
							The server Athena runs next to. Only people with access to it can use Athena, and only its owner can
							open Settings.
						</p>
						{effective.env.server ? (
							<p class="locked">
								<strong>{serverName(servers, machine)}</strong>
								<span>Set by PLEX_URL</span>
							</p>
						) : owned.length === 0 ? (
							<p class="banner error">
								Your Plex account doesn't own a Plex server. Sign in with the account that does.
							</p>
						) : (
							<div class="choices">
								{owned.map((server, index) => (
									<label class="choice">
										<input
											type="radio"
											name="server"
											value={server.id}
											checked={chosen ? server.id === chosen : index === 0}
											required
										/>
										<span>{server.name}</span>
									</label>
								))}
							</div>
						)}
					</fieldset>

					<fieldset>
						<legend>AI model</legend>
						<p class="hint">
							It reads each Describe It and makes the picks and suggestions. What people type goes to the provider you
							choose, on your key; a local model keeps it on your network.
						</p>
						{effective.env.provider && (
							<p class="locked">
								<strong>{providerOf(effective.provider).name}</strong>
								<span>Set by {effective.env.provider}</span>
							</p>
						)}
						<div class="choices providers" hidden={Boolean(effective.env.provider)}>
							{PROVIDERS.map((provider) => (
								<label class="choice">
									<input type="radio" name="provider" value={provider.id} checked={provider.id === effective.provider} />
									<span class="choice-text">
										{provider.name}
										{provider.id === 'local' ? (
											<small>On your network</small>
										) : (
											provider.brand !== provider.name && <small>{provider.brand}</small>
										)}
									</span>
								</label>
							))}
						</div>
						{PROVIDERS.map((provider) => (
							<ProviderPanel provider={provider} effective={effective} estimate={estimate} />
						))}
						<div class="test">
							<button type="button" class="secondary" data-test-key hidden>
								Test
							</button>
							<output class="test-result" aria-live="polite" />
						</div>
						<p class="hint">
							Test sends a small sample Describe It through the chosen model with the key above, the way Ithaca's
							requests go, before you save. It costs a fraction of a cent.
						</p>
					</fieldset>

					<fieldset>
						<legend>
							Jev <span class="optional">optional</span>
						</legend>
						<KeyField
							name="typesafeKey"
							label="TypeSafe API key"
							current={effective.typesafeKey}
							env={effective.env.typesafeKey}
							hint={
								<>
									Jev is TypeSafe's decision model. With a key, it makes the library picks: it answers yes or no for
									each title, in about a quarter of a second instead of about eight, for a thousandth of a cent, but
									writes no reason under them. Suggestions to request stay with the AI model above. Without a key, the
									AI model does both. Get a key at <a href="https://console.typesafe.ai/">console.typesafe.ai</a>.
								</>
							}
						/>
					</fieldset>

					<fieldset>
						<legend>Friends</legend>
						<label class="field">
							<span class="label">Public address</span>
							<input
								type="url"
								id="publicURL"
								name="publicURL"
								value={effective.publicURL ?? ''}
								placeholder="https://athena.example.com"
								autocomplete="off"
								autocapitalize="off"
								spellcheck={false}
							/>
							<span class="hint">
								Athena's HTTPS address as friends away from home reach it, like your Seerr. It needs a reverse proxy
								with a certificate in front of port 8800. Without one, Athena is home-only.
								{effective.publicURL && !setup && (
									<>
										{' '}
										<a href="/share">Share it</a>
									</>
								)}
							</span>
						</label>
						<label class="field">
							<span class="label">Daily limit per person</span>
							<input
								type="number"
								id="dailyLimit"
								name="dailyLimit"
								min="0"
								max="1000"
								inputmode="numeric"
								value={effective.dailyLimit ? String(effective.dailyLimit) : ''}
								placeholder="No limit"
							/>
							<span class="hint">
								Describe Its a day for each person except you; empty for none. Past it, Ithaca tells them they've used
								today's Describe Its on your Athena.
							</span>
						</label>
					</fieldset>

					<fieldset id="abs">
						<legend>
							Audiobookshelf <span class="optional">optional</span>
						</legend>
						{effective.env.absURL ? (
							<div class="field">
								<span class="label">Address</span>
								<span class="locked">
									<code>{effective.absURL}</code>
									<span>Set by {effective.env.absURL}</span>
								</span>
							</div>
						) : (
							<label class="field">
								<span class="label">Address</span>
								<input
									type="url"
									id="absURL"
									name="absURL"
									value={effective.absURL ?? ''}
									placeholder="http://192.168.1.10:13378"
									autocomplete="off"
									autocapitalize="off"
									spellcheck={false}
								/>
								<span class="hint">
									For automations that keep your audiobooks tidy, such as naming chapters that are only numbered.
									Leave it empty if you use Athena only for Ithaca.
								</span>
							</label>
						)}
						<KeyField
							name="absKey"
							label="Audiobookshelf API key"
							current={effective.absKey}
							env={effective.env.absKey}
							hint={
								<>
									Make one in Audiobookshelf under Settings › API Keys, for a user who can update books.
									{live.abs && !setup && (
										<>
											{' '}
											<a href="/automations">Open Automations</a>
										</>
									)}
								</>
							}
						/>
						<label class="field">
							<span class="label">Audible store</span>
							<select id="audibleRegion" name="audibleRegion">
								{AUDIBLE_REGIONS.map((region) => (
									<option value={region.id} selected={region.id === effective.audibleRegion}>
										{region.name}
									</option>
								))}
							</select>
							<span class="hint">
								Where chapter names are looked up first, by each book's ASIN. The other stores are tried when it has
								nothing that fits, and the results say which one matched.
							</span>
						</label>
						<div class="test">
							<button type="button" class="secondary" data-test-abs hidden>
								Test
							</button>
							<output class="test-result" aria-live="polite" />
						</div>
						<p class="hint">Test signs in to Audiobookshelf with the address and key above, before you save.</p>
						<SpeechFields effective={effective} />
					</fieldset>

					<div class="actions">
						<button type="submit" class="primary">
							{setup ? 'Save and finish' : 'Save'}
						</button>
						{saved && (
							<span class="saved" role="status">
								Saved
							</span>
						)}
					</div>
				</form>
			</Layout>
		);
	};

	/** One provider's key and model, shown while that provider is chosen. */
	const ProviderPanel: FC<{ provider: Provider; effective: Effective; estimate: Estimate }> = ({
		provider,
		effective,
		estimate,
	}) => {
		const chosen = provider.id === effective.provider;
		const locked = chosen && effective.env.model;
		if (provider.id === 'local')
			return (
				<div class="provider" data-provider="local">
					<label class="field">
						<span class="label">Address</span>
						<input
							type="url"
							name="localURL"
							value={effective.localURL ?? ''}
							placeholder="http://192.168.1.10:11434/v1"
							autocomplete="off"
							autocapitalize="off"
							spellcheck={false}
						/>
						<span class="hint">
							The OpenAI-style API of Ollama, LM Studio or another server on your network. Requests stay home and cost
							nothing per request, but reading a whole library takes a capable model and a fast machine.
						</span>
					</label>
					<label class="field">
						<span class="label">Model</span>
						{locked ? (
							<span class="locked">
								<strong>{effective.model}</strong>
								<span>Set by ATHENA_MODEL</span>
							</span>
						) : (
							<input
								type="text"
								name="model_local"
								list="local-models"
								value={chosen ? effective.model : ''}
								placeholder="Its name on that server"
								autocomplete="off"
								autocapitalize="off"
								spellcheck={false}
							/>
						)}
						<datalist id="local-models" />
						<span class="hint">Test lists the models that server has.</span>
					</label>
				</div>
			);
		const key = keyName(provider.id as Exclude<ProviderId, 'local'>);
		const selected = chosen ? effective.model : provider.models[0]?.id;
		const thousands = Math.round(estimate.prompts.suggestions / 1000);
		return (
			<div class="provider" data-provider={provider.id}>
				<KeyField
					name={key}
					label={`${provider.name} API key`}
					current={effective[key]}
					env={effective.env[key]}
					hint={
						<>
							Make one <a href={provider.keys}>at {provider.name}</a> with a monthly spend limit. Your friends'
							requests are on it too.
						</>
					}
				/>
				<div class="field">
					<span class="label">Model</span>
					{locked ? (
						<span class="locked">
							<strong>{modelName(effective.model)}</strong>
							<span>Set by ATHENA_MODEL</span>
						</span>
					) : (
						<div class="tiers" role="radiogroup" aria-label={`${provider.name} model`}>
							{provider.models.map((model) => (
								<Tier model={model} name={`model_${provider.id}`} checked={model.id === selected} estimate={estimate} />
							))}
						</div>
					)}
					<span class="hint">
						Fast answers quickest; Best reads requests most carefully. A Describe It is Ithaca's two requests, picks
						and suggestions, each carrying the library: about {thousands}K tokens{' '}
						{estimate.measured ? 'going by your recent requests' : 'for 600 titles, until Athena has seen yours'}.
						{estimate.jev ? ' With Jev, the picks request goes to Jev, for almost nothing.' : ''} Asking again with the
						same filters within a few minutes costs less, from caching.
					</span>
				</div>
			</div>
		);
	};

	/** One tier to choose, with its list price and about what a Describe It costs on it. */
	const Tier: FC<{ model: Model; name: string; checked: boolean; estimate: Estimate }> = ({
		model,
		name,
		checked,
		estimate,
	}) => {
		const price = listPrice(model.id);
		const each = perDescribeIt(model.id, estimate.prompts, estimate.jev);
		return (
			<label class="tier">
				<input type="radio" name={name} value={model.id} checked={checked} />
				<span class="tier-name">
					<span>
						<strong>{model.tier}</strong> {model.name}
					</span>
					<small>
						{price
							? `${perMillion(price.input)} in, ${perMillion(price.output)} out per million tokens`
							: 'Price not known'}
					</small>
				</span>
				{each !== null && (
					<span class="tier-cost">
						<strong>{cents(each)}</strong>
						<small>a Describe It</small>
					</span>
				)}
			</label>
		);
	};

	/** A reading's titles, chapter by chapter, beside what was heard: folded away until opened. */
	const Proposal: FC<{ before: string[]; after: Heard[] }> = ({ before, after }) => (
		<details class="proposal">
			<summary>All {after.length} chapters</summary>
			<table>
				<thead>
					<tr>
						<th scope="col">Now</th>
						<th scope="col">Title</th>
						<th scope="col">Heard</th>
					</tr>
				</thead>
				<tbody>
					{after.map((chapter, index) => (
						<tr class={chapter.title === before[index] ? 'same' : undefined}>
							<td>{before[index]}</td>
							<td>{chapter.title}</td>
							<td class="heard">{chapter.heard || '(nothing)'}</td>
						</tr>
					))}
				</tbody>
			</table>
		</details>
	);

	/** What reads the audio for Titles from the audio: ElevenLabs with its key, or Whisper when the image has it. */
	const SpeechFields: FC<{ effective: Effective }> = ({ effective }) => {
		const model = whisperModel();
		return (
			<>
				<label class="field">
					<span class="label">Speech to text</span>
					<select id="speech" name="speech">
						<option value="elevenlabs" selected={effective.speech === 'elevenlabs'}>
							ElevenLabs Scribe
						</option>
						<option value="whisper" selected={effective.speech === 'whisper'} disabled={!model && effective.speech !== 'whisper'}>
							{model ? `Whisper ${whisperName(model)}, on this server` : 'Whisper, on this server (needs the speech image)'}
						</option>
					</select>
					<span class="hint">
						For Titles from the audio, which reads the first seconds of each chapter.{' '}
						{model
							? 'Whisper is free and runs here; ElevenLabs is more accurate with names, at $0.20 an hour of audio (about 3¢ for a book of 40 chapters).'
							: 'ElevenLabs costs $0.20 an hour of audio: about 3¢ for a book of 40 chapters.'}
						{!hasFfmpeg() && ' Reading the audio needs the speech image, which has ffmpeg: build Athena with ATHENA_TARGET=speech.'}
					</span>
				</label>
				<KeyField
					name="elevenlabsKey"
					label="ElevenLabs API key"
					current={effective.elevenlabsKey}
					env={effective.env.elevenlabsKey}
					hint={`Make one at elevenlabs.io under Developers › API Keys, with Speech to Text allowed. Athena uses ${SCRIBE_MODEL} and sends only the chapter openings.`}
				/>
			</>
		);
	};

	const KeyField: FC<{ name: string; label: string; current: string | null; env?: string; hint: Child }> = ({
		name,
		label,
		current,
		env,
		hint,
	}) =>
		env ? (
			<div class="field">
				<span class="label">{label}</span>
				<span class="locked">
					<code>{mask(current)}</code>
					<span>Set by {env}</span>
				</span>
				<span class="hint">{hint}</span>
			</div>
		) : (
			<div class="field">
				<label class="label" for={name}>
					{label}
				</label>
				{current && (
					<span class="current">
						<code>{mask(current)}</code>
						<label class="remove">
							<input type="checkbox" name={`${name}Remove`} value="1" /> Remove
						</label>
					</span>
				)}
				<input
					type="password"
					id={name}
					name={name}
					autocomplete="off"
					spellcheck={false}
					placeholder={current ? 'Paste a new key to replace it' : 'Paste the key'}
				/>
				<span class="hint">{hint}</span>
			</div>
		);

	app.post('/settings', async (c) => {
		if (!sameSite(c)) return c.text('Forbidden', 403);
		const found = await who(c);
		if ('page' in found) return found.page;
		const { s, role, servers } = found;
		if (role !== 'owner' && role !== 'setup') return c.redirect('/', 303);
		const form = await c.req.parseBody();
		const text = (key: string) => (typeof form[key] === 'string' ? (form[key] as string).trim() : '');
		const effective = live.effective;
		const patch: Parameters<typeof live.settings.save>[0] = {};

		if (!effective.env.server) {
			const server = servers.find((candidate) => candidate.owned && candidate.id === text('server'));
			if (!server) return c.redirect('/settings?problem=server', 303);
			patch.server = { id: server.id, name: server.name };
		}
		const chosen = text('provider');
		const provider = providerOf(!effective.env.provider && isProvider(chosen) ? chosen : effective.provider);
		// Saved even when ATHENA_PROVIDER chooses it, so the model saved with it is read back for it.
		patch.provider = provider.id;
		const keys: (KeyName | 'typesafeKey')[] = [...PROVIDERS.flatMap((each) => (each.id === 'local' ? [] : [keyName(each.id)])), 'typesafeKey'];
		for (const key of keys) {
			if (effective.env[key]) continue;
			if (text(`${key}Remove`)) patch[key] = null;
			if (text(key)) patch[key] = text(key);
		}
		if (!effective.env.model) {
			// A local server's model is whatever it calls it; the others come from their list.
			const model = text(`model_${provider.id}`);
			if (provider.id === 'local') patch.model = model.slice(0, 200) || null;
			else if (provider.models.some((candidate) => candidate.id === model)) patch.model = model;
		}
		const local = text('localURL');
		patch.localURL = local ? localBase(local) : null;
		if (local && !patch.localURL) return c.redirect('/settings?problem=local', 303);
		const limit = text('dailyLimit');
		if (limit && !/^\d{1,4}$/.test(limit)) return c.redirect('/settings?problem=limit', 303);
		patch.dailyLimit = limit ? Number(limit) : null;
		const address = text('publicURL');
		patch.publicURL = address ? publicAddress(address) : null;
		if (address && !patch.publicURL) return c.redirect('/settings?problem=public', 303);
		if (!effective.env.absURL) {
			const abs = text('absURL');
			patch.absURL = abs ? absBase(abs) : null;
			if (abs && !patch.absURL) return c.redirect('/settings?problem=abs', 303);
		}
		if (!effective.env.absKey) {
			if (text('absKeyRemove')) patch.absKey = null;
			if (text('absKey')) patch.absKey = text('absKey');
		}
		const region = text('audibleRegion');
		if (AUDIBLE_REGIONS.some((each) => each.id === region)) patch.audibleRegion = region;
		const speech = text('speech');
		if (speech === 'elevenlabs' || speech === 'whisper') patch.speech = speech;
		if (!effective.env.elevenlabsKey) {
			if (text('elevenlabsKeyRemove')) patch.elevenlabsKey = null;
			if (text('elevenlabsKey')) patch.elevenlabsKey = text('elevenlabsKey');
		}
		patch.ownerName = s.name;
		patch.ownerId = s.accountId;
		patch.ownerToken = s.token;

		live.settings.save(patch);
		live.refresh();
		return c.redirect(role === 'setup' && live.gate && (live.ai || live.jevKey) ? '/' : '/settings?saved', 303);
	});

	/**
	 * Settings' Test: a three-title sample Describe It through the chosen provider, key and model, by the same code
	 * Ithaca's requests take, so a rejected key, a model the key can't use or a parameter the provider refuses shows up
	 * here first. It costs a fraction of a cent and isn't logged. A local server's models come back for the Model field.
	 */
	/** Settings' Audiobookshelf Test: signs in with the address and key typed (or saved) and lists the book libraries. */
	app.post('/settings/test-abs', async (c) => {
		if (!sameSite(c)) return c.json({ ok: false, message: 'Forbidden' }, 403);
		const found = await who(c);
		if ('page' in found) return c.json({ ok: false, message: 'Sign in again.' }, 401);
		const setter = found.role === 'owner' || (found.role === 'setup' && found.servers.some((server) => server.owned));
		if (!setter) return c.json({ ok: false, message: 'Only the owner can test this.' }, 403);
		const form = await c.req.parseBody();
		const field = (key: string) => (typeof form[key] === 'string' ? (form[key] as string).trim() : '');
		const effective = live.effective;
		const typed = effective.env.absURL ? '' : field('absURL');
		const url = typed ? absBase(typed) : effective.absURL;
		if (typed && !url) return c.json({ ok: false, message: PROBLEMS.get('abs') });
		const key = (effective.env.absKey ? '' : field('absKey')) || effective.absKey;
		if (!url || !key) return c.json({ ok: false, message: 'Enter the address and an API key first.' });
		const abs = new Audiobookshelf(url, key, live.fetcher);
		try {
			const user = await abs.me();
			const libraries = (await abs.libraries()).filter((library) => library.mediaType === 'book');
			const counted = await Promise.all(libraries.map(async (library) => `${library.name} (${books(await abs.count(library.id))})`));
			const where = counted.length ? `Book libraries: ${counted.join(', ')}.` : 'It has no book libraries.';
			if (!user.canUpdate)
				return c.json({
					ok: false,
					message: `Signed in as ${user.username}, but that user can't update books, so Athena could only check. ${where}`,
				});
			return c.json({ ok: true, message: `Signed in as ${user.username}, who can update books. ${where}` });
		} catch (error) {
			return c.json({ ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post('/settings/test', async (c) => {
		if (!sameSite(c)) return c.json({ ok: false, message: 'Forbidden' }, 403);
		const found = await who(c);
		if ('page' in found) return c.json({ ok: false, message: 'Sign in again.' }, 401);
		// Test spends the key, so before setup only someone who could set Athena up may run it.
		const setter = found.role === 'owner' || (found.role === 'setup' && found.servers.some((server) => server.owned));
		if (!setter) return c.json({ ok: false, message: 'Only the owner can test keys.' }, 403);
		const form = await c.req.parseBody();
		const field = (key: string) => (typeof form[key] === 'string' ? (form[key] as string).trim() : '');
		const effective = live.effective;
		const chosen = field('provider');
		const provider = providerOf(!effective.env.provider && isProvider(chosen) ? chosen : effective.provider);
		const model = effective.env.model
			? effective.model
			: field('model') || (provider.id === effective.provider ? effective.model : (provider.models[0]?.id ?? ''));
		const trying: Effective = { ...effective, provider: provider.id, model };

		let models: string[] | undefined;
		if (provider.id === 'local') {
			const typed = field('localURL');
			const base = typed ? localBase(typed) : effective.localURL;
			if (typed && !base) return c.json({ ok: false, message: LOCAL_ADDRESS });
			if (!base) return c.json({ ok: false, message: "Enter the local server's address first." });
			try {
				const listed = await listModels(base, null, live.fetcher);
				if (listed === 'rejected') return c.json({ ok: false, message: 'That server refused Athena.' });
				models = listed;
			} catch {
				return c.json({ ok: false, message: "Athena couldn't reach that address." });
			}
			const has = models.join(', ') || 'none';
			if (!model) return c.json({ ok: true, message: `Reached it. Its models: ${has}. Choose one and test again.`, models });
			if (!models.some((name) => name === model || name === `${model}:latest`))
				return c.json({ ok: false, message: `Reached it, but it has no ${model}. Its models: ${has}.`, models });
			trying.localURL = base;
		} else {
			const name = keyName(provider.id);
			const key = (!effective.env[name] && field(name)) || effective[name];
			if (!key) return c.json({ ok: false, message: 'Paste a key first.' });
			trying[name] = key;
		}

		const ai = makeAI(trying, live.fetcher);
		if (!ai) return c.json({ ok: false, message: 'Choose a model first.' });
		const started = Date.now();
		try {
			const outcome = await ai.pick(SAMPLE);
			const seconds = ((Date.now() - started) / 1000).toFixed(1);
			const picked = SAMPLE.titles.find((title) => title.id === outcome.picks[0]?.id)?.title;
			const suggested = outcome.suggestions[0]?.title;
			const what = [picked && `picked ${picked}`, suggested && `suggested ${suggested}`].filter(Boolean).join(' and ');
			const spent = cost(ai.by, outcome.usage);
			return c.json({
				ok: true,
				message:
					`Works. ${modelName(ai.by)} ${what || 'answered'} for "${SAMPLE.request}" in ${seconds} s` +
					(spent ? `, for ${cents(spent)}.` : '.'),
				models,
			});
		} catch (error) {
			return c.json({ ok: false, message: error instanceof Error ? error.message : String(error), models });
		}
	});
}

const LOCAL_ADDRESS = "The local model's address is an http:// address, such as http://192.168.1.10:11434/v1.";

/** Why Settings refused a save, by the code in the address, so a link can't put its own words on the page. */
const PROBLEMS = new Map([
	['server', 'Choose a Plex server you own.'],
	['local', LOCAL_ADDRESS],
	['limit', 'The daily limit is a whole number, or empty for none.'],
	['public', 'The public address is an https:// address, such as https://athena.example.com.'],
	['abs', "Audiobookshelf's address is an http:// or https:// address, such as http://192.168.1.10:13378."],
]);

const RUN_PROBLEMS = new Map([
	['busy', 'Another job is running. Try again when it finishes.'],
	['changed', 'Its chapters have changed since, so they were left as they are.'],
	['nothing', 'There’s nothing left to do there: it was already done.'],
	['failed', "Audiobookshelf didn't take that. Try again in a minute."],
	['unconnected', 'Connect Audiobookshelf in Settings first.'],
	['unknown', 'There is no such job.'],
]);

/** Settings' Test request: small, so it costs next to nothing, with one clear fit. */
const SAMPLE = PickRequest.parse({
	request: 'something funny and short',
	kind: 'movie',
	count: 1,
	titles: [
		{ id: '1', title: 'Airplane!', year: 1980, genres: ['Comedy'], minutes: 88 },
		{ id: '2', title: 'Heat', year: 1995, genres: ['Crime', 'Thriller'], minutes: 170 },
		{ id: '3', title: "Schindler's List", year: 1993, genres: ['Drama', 'History'], minutes: 195 },
	],
	suggest: 1,
});
