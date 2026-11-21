import Anthropic from '@anthropic-ai/sdk';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { raw } from 'hono/html';
import type { Child, FC } from 'hono/jsx';
import type { Live } from './live';
import { warn } from './log';
import type { Server } from './plex';
import { MODELS } from './prices';
import { mask } from './settings';
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

const modelName = (id: string) =>
	id === 'jev' ? 'Jev' : (MODELS.find((model) => model.id === id)?.name.replace('Claude ', '') ?? id);

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
	nav?: 'status' | 'share' | 'settings';
	bare?: boolean;
	children: Child;
}> = ({ title, signedIn, nav, bare, children }) => (
	<>
		{raw('<!doctype html>')}
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<meta name="robots" content="noindex" />
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
	const { live, usage, sessions } = web;
	const now = web.now ?? Date.now;

	const files = ['app.css', 'app.js', 'icon.svg', 'mark.svg', 'favicon-32.png', 'apple-touch-icon.png'];
	for (const file of [...files, 'favicon.ico']) {
		const source = new URL(`../public/${file === 'favicon.ico' ? 'favicon-32.png' : file}`, import.meta.url);
		app.get(`/${file}`, () => new Response(Bun.file(source), { headers: { 'Cache-Control': 'public, max-age=3600' } }));
	}

	app.use('*', async (c, next) => {
		await next();
		if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
			c.res.headers.set('Cache-Control', 'no-store');
			c.res.headers.set('X-Frame-Options', 'DENY');
			c.res.headers.set('Referrer-Policy', 'same-origin');
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
		return { role: server?.owned ? 'owner' : server ? 'viewer' : 'none', servers, machine };
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
				<p class="lede">Describe It for Ithaca, answered by Claude from your own Plex library.</p>
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
		if (!live.client && !live.jevKey)
			return { state: 'off', title: 'Not ready', detail: 'Add an Anthropic API key in Settings.' } as const;
		if (!live.client)
			return {
				state: 'partial',
				title: 'Partly ready',
				detail: `Library picks for ${name} come from Jev. Suggestions need an Anthropic API key.`,
			} as const;
		return {
			state: 'on',
			title: 'Ready',
			detail: `Answering for ${name} with ${modelName(live.model)}${live.jevKey ? '. Library picks by Jev' : ''}.`,
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
		const people = usage.todayByPerson();
		const limit = live.dailyLimit;
		return c.html(
			<Layout title="Status" signedIn={s} nav="status">
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
						<h2>Today by person</h2>
						<ul>
							{people.map((person) => {
								const you = person.viewerId === s.accountId;
								const full = !you && limit !== null && person.count >= limit;
								return (
									<li class={full ? 'full' : undefined}>
										<span class="person">
											{person.viewer ?? 'Unknown'}
											{you && <span class="you">you, no limit</span>}
										</span>
										<span class="count">
											<strong>{person.count}</strong>
											{!you && limit ? ` of ${limit}` : ''}
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
										<tr class={entry.status === 200 ? undefined : 'failed'}>
											<td class="when">{when(entry.at, now())}</td>
											<td class="viewer">{entry.viewer ?? 'Unknown'}</td>
											<td class="request">
												<span class="kind">{entry.kind === 'show' ? 'TV' : 'Film'}</span> {entry.request}
											</td>
											<td class="answer">{result(entry)}</td>
											<td class="by">{entry.by ? modelName(entry.by) : ''}</td>
											<td class="num took">{entry.status === 429 ? '' : duration(entry.ms)}</td>
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
			<Layout title="Share" signedIn={s} nav="share">
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
					requests are on your Anthropic bill;{' '}
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
				problem={c.req.query('problem') ?? null}
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
		const models = MODELS.some((model) => model.id === effective.model)
			? MODELS
			: [...MODELS, { id: effective.model, name: effective.model }];
		return (
			<Layout title={setup ? 'Set up' : 'Settings'} signedIn={s} nav={setup ? undefined : 'settings'}>
				<div class="page-head">
					<h1>{setup ? 'Set up Athena' : 'Settings'}</h1>
					{setup && (
						<p class="lede">
							Athena runs next to Plex and Seerr. Choose your Plex server and add an Anthropic API key; your
							household's Ithaca finds Athena on port 8800 by itself once it's ready.
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
						<legend>Claude</legend>
						<KeyField
							name="anthropicKey"
							label="Anthropic API key"
							current={effective.anthropicKey}
							env={effective.env.anthropicKey}
							hint="Make it in its own Claude Console workspace with a monthly spend limit. Your friends' requests are on it too."
						/>
						<label class="field">
							<span class="label">Model</span>
							{effective.env.model ? (
								<span class="locked">
									<strong>{modelName(effective.model)}</strong>
									<span>Set by ATHENA_MODEL</span>
								</span>
							) : (
								<select name="model">
									{models.map((model) => (
										<option value={model.id} selected={model.id === effective.model}>
											{model.name}
										</option>
									))}
								</select>
							)}
							<span class="hint">
								Haiku costs about a quarter of a cent a request with a 600-title library. Sonnet costs about 20 times
								that, Opus about 40.
							</span>
						</label>
						<div class="test">
							<button type="button" class="secondary" data-test-key hidden>
								Test key
							</button>
							<output class="test-result" aria-live="polite" />
						</div>
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
							hint="Library picks from Jev in a quarter of a second instead of about eight, without a reason under each. Suggestions stay with Claude."
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

	const KeyField: FC<{ name: string; label: string; current: string | null; env?: string; hint: string }> = ({
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
			if (!server) return c.redirect(`/settings?problem=${encodeURIComponent('Choose a Plex server you own.')}`, 303);
			patch.server = { id: server.id, name: server.name };
		}
		for (const key of ['anthropicKey', 'typesafeKey'] as const) {
			if (effective.env[key]) continue;
			if (text(`${key}Remove`)) patch[key] = null;
			if (text(key)) patch[key] = text(key);
		}
		if (!effective.env.model && text('model')) {
			const allowed = MODELS.some((model) => model.id === text('model')) || text('model') === effective.model;
			if (allowed) patch.model = text('model');
		}
		const limit = text('dailyLimit');
		if (limit && !/^\d{1,4}$/.test(limit))
			return c.redirect(
				`/settings?problem=${encodeURIComponent('The daily limit is a whole number, or empty for none.')}`,
				303,
			);
		patch.dailyLimit = limit ? Number(limit) : null;
		const address = text('publicURL');
		patch.publicURL = address ? publicAddress(address) : null;
		if (address && !patch.publicURL)
			return c.redirect(
				`/settings?problem=${encodeURIComponent('The public address is an https:// address, such as https://athena.example.com.')}`,
				303,
			);
		patch.ownerName = s.name;

		live.settings.save(patch);
		live.refresh();
		return c.redirect(role === 'setup' && live.gate && (live.client || live.jevKey) ? '/' : '/settings?saved', 303);
	});

	/** Checks an Anthropic key against the chosen model without spending anything. */
	app.post('/settings/test', async (c) => {
		if (!sameSite(c)) return c.json({ ok: false, message: 'Forbidden' }, 403);
		const found = await who(c);
		if ('page' in found) return c.json({ ok: false, message: 'Sign in again.' }, 401);
		if (found.role !== 'owner' && found.role !== 'setup')
			return c.json({ ok: false, message: 'Only the owner can test keys.' }, 403);
		const form = await c.req.parseBody();
		const typed = typeof form.anthropicKey === 'string' ? form.anthropicKey.trim() : '';
		const effective = live.effective;
		const key = (!effective.env.anthropicKey && typed) || effective.anthropicKey;
		const model = (!effective.env.model && typeof form.model === 'string' && form.model) || effective.model;
		if (!key) return c.json({ ok: false, message: 'Paste a key first.' });
		try {
			await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 10_000 }).models.retrieve(model);
			return c.json({ ok: true, message: `Works. ${modelName(model)} is available to this key.` });
		} catch (error) {
			if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
				return c.json({ ok: false, message: 'Anthropic rejected this key.' });
			if (error instanceof Anthropic.NotFoundError)
				return c.json({ ok: false, message: `The key works, but it can't use ${modelName(model)}.` });
			if (error instanceof Anthropic.APIConnectionError)
				return c.json({ ok: false, message: "Athena couldn't reach Anthropic. Check its internet connection." });
			return c.json({ ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	});
}
