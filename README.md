<p align="center"><img src="unraid-icon.png" width="96" alt=""></p>

# Athena

**The AI and automation companion for Ithaca and Siren.**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![gitleaks](https://github.com/inceptyon-labs/athena/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/inceptyon-labs/athena/actions/workflows/gitleaks.yml)

Athena answers Describe It in [Ithaca](https://inceptyon.io/ithaca/support), the Plex app for Apple TV, iPhone and
iPad. Describe It is part of Ithaca Pro: you type what you're in the mood for ("something funny under two hours") and
Ithaca picks from your library. Ithaca can do that on the device by itself. With Athena on your network, an AI model
you choose reads the request instead (Claude, GPT, Gemini, Grok, DeepSeek, or a model on your own machine): it
understands any phrasing, knows films your library doesn't have (so its To Request suggestions are better when Seerr is
connected), and gives a one-line reason for each pick.

If you also run [Audiobookshelf](https://www.audiobookshelf.org) (for [Siren](https://inceptyon.io/siren/support) or
any other audiobook app), Athena can tidy it too: it names chapters that are only numbered, from Audible or from what
the narrator reads at the start of each chapter, and changes nothing you haven't approved ([Automations](#automations-audiobookshelf)).

Athena is a small server you run yourself, next to Plex and Seerr. Your household's Ithaca finds it on your home
network by itself; friends who use your Plex from outside reach it the way they reach your Seerr, at an HTTPS address.
Your API keys stay on it, so the apps need none. It reads no library: Ithaca sends the titles that fit the
screen's filters with each request. Only people with access to your Plex server can use it.

## Install

Run Athena next to Plex and Seerr: on the machine Plex runs on, or another on the same home network. It works only with
a Plex server you own. You need Docker and either an API key from Anthropic, OpenAI, Google, xAI or DeepSeek, or a
model server on your network such as Ollama or LM Studio. Make the key in its own project or workspace with a monthly
spend limit.

### Unraid

In Community Apps, search for **Athena** and install it. Keep ports 8800 and 8801, and keep the data path
(`/mnt/user/appdata/athena`) unless you store app data elsewhere. Then open the WebUI, which is on port 8801.

### Docker Compose

```yaml
services:
  athena:
    image: ghcr.io/inceptyon-labs/athena:latest
    container_name: athena
    restart: unless-stopped
    ports:
      - "192.168.1.10:8800:8800" # this machine's home-network address: Ithaca, and friends through your proxy
      - "192.168.1.10:8801:8801" # Settings and Automations: the home network only, never through a proxy
    volumes:
      - ./data:/data
    environment:
      TZ: America/New_York
```

`docker compose up -d`, then open `http://192.168.1.10:8801`. Publish both ports on the machine's home-network address,
never `0.0.0.0` on a machine that faces the internet.

To build from source instead, clone this repository, `cp .env.example .env`, set `ATHENA_BIND` in it, and run
`docker compose up -d --build`.

## First run

1. Open Athena in a browser at port 8801 and **Sign in with Plex**, with the account that owns your Plex server. Plex asks you to
   approve the sign-in, then sends you back.
2. Choose your Plex server. Only people with access to it can use Athena, and only its owner can open Settings.
3. Choose an AI model: the provider, its API key and a tier (Fast, Balanced or Best). Each tier shows its price and
   about what a Describe It costs on it (below); Fast is the default and the cheapest. Press **Test** to send a small
   sample request through it, the way Ithaca's requests go, before you save.
4. Optionally add a TypeSafe key for Jev (below), a public address for friends away from home (below) and a daily
   limit per person. Save.

The status page then says whether Athena is ready and why not, how many Describe Its it answered today and this month,
an estimate of what that cost, how many each person used today and this month with what theirs cost, and the last 50
requests: who asked, what they typed, the answer, the model and how long it took.

At home, Athena turns up in Ithaca by itself when it runs on the Plex machine with port 8800: Ithaca asks port 8800 on
the home-network address of each Plex server it reaches. Running elsewhere, enter its address in Ithaca under
Settings → Athena. Before the first request, Ithaca asks the viewer whether Describe It may use Athena, since what
they type goes on to the provider you chose (unless it's a local model).

Settings are kept in the data folder, `settings.json`, readable only by Athena; API keys are never shown back in full
or logged. The request log is `athena.db` in the same folder and keeps a little over a year.

### Keeping keys safe

- **Settings stay home.** Athena listens on two ports. 8800 answers Ithaca and friends, and shows you the status page
  and Share; 8801 also has Settings and Automations, and opens them only to a home-network address (private ranges,
  and the 100.64.0.0/10 range Tailscale uses). Put a reverse proxy or tunnel in front of 8800 only. Your public address
  always goes through the internet, even from home, so open Settings at the home address and port 8801. Port 8801 also
  turns away a request a proxy says came from the internet, in case it's published by mistake. To change settings
  from away, use a VPN home, or turn on Settings → Settings from anywhere, which opens them on 8800 behind Plex
  sign-in.
- **Keys in the browser** go into `settings.json`, which isn't encrypted: anyone who can read the data folder, or a
  backup of it, can read them. Whoever has root on the machine can read them however they're stored.
- **Keys from a vault or Docker secrets**: each key variable below can name a file instead, as `<NAME>_FILE` (such as
  `ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic`). Athena reads it when it starts, keeps it only in memory and shows
  the field locked. A vault's agent (1Password, Bitwarden Secrets Manager, Infisical, Vault) or Docker secrets can
  write that file, so the key never goes into `settings.json` or the app-data backups. Restart Athena after the file
  changes.
- **Cap every key** where you make it: a monthly spend limit on the Anthropic workspace or OpenAI project, a credit
  limit on the ElevenLabs key with only Speech to Text and User read allowed, an Audiobookshelf user who can update
  books but isn't an admin. A leaked key then costs at most its cap.
- Signing in lasts 7 days, and a restart signs everyone out. Every form carries a per-sign-in token, so another site
  can't post one for you.

## Automations (Audiobookshelf)

Optional, for people who also run [Audiobookshelf](https://www.audiobookshelf.org) (and use
[Siren](https://inceptyon.io/siren/support), or any other Audiobookshelf app). Leave it out and Athena is only Ithaca's
Describe It, with nothing else to set up.

Under Settings → Audiobookshelf, enter its address (`http://192.168.1.10:13378`) and an API key made in Audiobookshelf
under Settings → API Keys, for a user who can update books. An **Automations** page then appears. Its first job,
**Chapter names**, finds books whose chapters are only numbered ("Chapter 1", "01", "Track 3") and looks up Audible's
names for them by ASIN, through Audiobookshelf. It takes them only when Audible has as many chapters as the book, each
starting within 2 seconds of the book's, so only titles change, never where chapters start. It asks your Audible store
first (Settings → Audible store), then the UK and Canada, then the others, and says which store matched.

- **Check now** lists what it would rename and changes nothing. From its results, **Rename** renames those books,
  reading each one again first and leaving it alone if it changed. Every app, Siren included, sees the new names.
- **Undo**, on each renamed book, puts its old titles back, unless its chapters have changed since.
- **Run by itself every hour** (off until you turn it on) looks at books added or changed since its last run and
  renames those that fit, so new books get names without you.

The second job, **Titles from the audio**, is for books whose chapters are only numbered and that no Audible store can
name. It cuts the first 20 seconds of each chapter with ffmpeg (reading only those seconds over Audiobookshelf's API),
turns them into text, and has the AI model you chose for Describe It write the titles the narrator reads, such as
"Chapter 12: The Long Night" or "Opening Credits".

- **Check now** lists the books it could read, with what reading each would cost, and costs nothing.
- **Read**, for one book or all of them, does the reading. Nothing is renamed yet: each book waits for you, with its
  titles beside what was heard at the start of each chapter.
- **Approve** reads the book again and saves its titles, unless its chapters changed since; **Reject** leaves it.
  **Undo** puts the numbers back. It never runs by itself, since each reading costs a little.

Speech to text is your choice in Settings:

- **ElevenLabs Scribe**, with an ElevenLabs API key: $0.20 an hour of audio, billed by the second, so about 5¢ for a
  book of 40 chapters. Only the chapter openings are sent. Each reading's log says how many credits it used, and with
  the key's User read permission the Automations page shows how many are left on your plan.
- **Whisper on this server**, free, with whisper.cpp. Only the speech image has it.

Both need the **speech image**, which adds ffmpeg and whisper.cpp to Athena (about 1.2 GB). Building from source, set
`ATHENA_TARGET=speech` in `.env`, and `WHISPER_MODEL` there to choose Whisper's model (`small.en` by default).

Jobs run one at a time in the background and never slow Describe It; their log is `jobs.db` in the data folder.

## Environment variables

All optional. The ones that set something in Settings win over what's saved there, and Settings shows that field
locked. Each key (the `_API_KEY` variables) can instead be read from a file, named by the same variable with `_FILE`
added ([Keeping keys safe](#keeping-keys-safe)).

| Variable | What it sets |
| --- | --- |
| `PLEX_URL` | The Plex server, by its address (`http://192.168.1.10:32400`), in place of choosing it in Settings |
| `ATHENA_PROVIDER` | The AI provider: `anthropic`, `openai`, `gemini`, `xai`, `deepseek` or `local` |
| `ATHENA_MODEL` | The model's id, such as `claude-haiku-5-5`. Without `ATHENA_PROVIDER`, it also sets the provider whose list has that model |
| `ANTHROPIC_API_KEY` | Anthropic's API key, for Claude |
| `OPENAI_API_KEY` | OpenAI's API key, for GPT |
| `GEMINI_API_KEY` | Google's API key, for Gemini |
| `XAI_API_KEY` | xAI's API key, for Grok |
| `DEEPSEEK_API_KEY` | DeepSeek's API key |
| `TYPESAFE_API_KEY` | The TypeSafe key for Jev, which makes the library picks ([How it picks](#how-it-picks)) |
| `ABS_URL` | Audiobookshelf's address, for [automations](#automations-audiobookshelf) |
| `ABS_API_KEY` | An Audiobookshelf API key from a user who can update books |
| `ELEVENLABS_API_KEY` | ElevenLabs' API key, for [Titles from the audio](#automations-audiobookshelf) |
| `ATHENA_TARGET` | Building from source only, in `.env`: `speech` builds the speech image, with ffmpeg and whisper.cpp |
| `WHISPER_MODEL` | Building the speech image, in `.env`: whisper.cpp's model, such as `base.en` or `small.en` (the default) |
| `TZ` | The time zone that "today" and "this month" follow on the status page. `America/New_York` by default |
| `PUID`, `PGID` | The user and group Athena runs as, and gives the data folder to. 99 and 100 (Unraid's nobody:users) by default |
| `ATHENA_BIND` | Building from source only, in `.env`: this machine's home-network address, which Compose publishes Athena on |
| `ATHENA_PORT` | Building from source only, in `.env`: the port Compose publishes. Keep 8800, the default, so Ithaca finds Athena by itself |
| `ATHENA_ADMIN_PORT` | Building from source only, in `.env`: the port for Settings and Automations, home network only. 8801 by default |

## Who can use it

Only people who can use your Plex server: you, your Plex Home profiles, and friends you share the library with. Ithaca
sends the viewer's token for your server with each request, never their Plex account token, so running Athena gives you
nothing of theirs beyond what sharing your server already does. Athena checks it against the list plex.tv keeps of who
your server is shared with and their tokens for it, which it reads with your Plex token (kept in `data/settings.json`
from your last sign-in to the web page, and never shown or logged), so the status page lists people by name. Your own
token for your server is your account token, which Athena checks with plex.tv directly, as it does the account tokens
older Ithaca versions send. After updating from a version that didn't keep your token, sign in to the web page once;
until then only you can use Describe It from the newer Ithaca. Stop sharing with someone in Plex and they lose Athena
too. Answers are kept for ten minutes, by a hash of the token; viewers' tokens are never stored or logged. Until a Plex
server is chosen, Athena answers no one.

Anyone with access can sign in to the web page too; people other than the owner see only how many Describe Its they
used today. The daily limit is per person, off until you set one, and never applies to you. Only Describe Its that
the AI model or Jev answered count, including answers Athena couldn't use, since the provider charges for those too.
Ithaca's picks and suggestions for the same request count once. Past it,
Ithaca shows them "You've used Describe It 20 times today on Jason's Athena. It resets at midnight.", with your name
as Plex shows it.

The first person to sign in to a new Athena chooses its Plex server from the servers they own, so set it up right
after installing, from home: setup, like Settings, opens only on port 8801 from your home network. From then on, only
that Plex account opens Settings. To start over, stop Athena and delete `settings.json` from the data folder.

## Friends away from home

Without a public address, Athena is home-only. Friends who use your Plex from outside your home reach it the way they
reach your Seerr: at an HTTPS address, through a reverse proxy or Cloudflare Tunnel with a certificate in front of port
8800 (never 8801), such as Caddy:

```
athena.example.com {
	reverse_proxy 192.168.1.10:8800
}
```

Enter that address under Settings → Public address, then open **Share**. It shows:

- a link, `ithaca://athena?url=https%3A%2F%2Fathena.example.com`, to send in a message;
- a QR code of that link: scanned with an iPhone or iPad camera, it opens Ithaca with the address filled in;
- the address in large type, for Apple TV, where they type it in Ithaca under Settings → Athena.

Ithaca saves the address and asks its usual question before the first request. Friends can sign in at that address to
see their own use; Settings stay on your home network. Friends' requests are on your API bill; set a daily limit if
that worries you.

## Models and cost

Each provider has up to three tiers. Fast answers quickest and costs least; Best reads requests most carefully. A
Describe It is two requests from Ithaca, picks and suggestions, sent at once and each carrying the library: a 600-title
library is about 25K input tokens, and the suggestions request adds Seerr's recent list, about 4K more. Before caching,
a Describe It costs about:

| Provider | Fast | Balanced | Best |
| --- | --- | --- | --- |
| Anthropic | Claude Haiku 5.5, 0.6¢ | Claude Sonnet 5.5, 12¢ | Claude Opus 5.5, 23¢ |
| OpenAI | GPT-6 Luna, 0.6¢ | GPT-6.2 Sol, 12¢ | GPT-6.2 Astra, 46¢ |
| Google | Gemini 3.5 Flash-Lite, 2¢ | Gemini 4 Hydrogen, 9¢ | Gemini 4 Carbon, 23¢ |
| xAI | Grok 4.3, 7¢ | Grok 4.5, 11¢ | Grok 4.7, 11¢ |
| DeepSeek | DeepSeek Flash, 2¢ | | DeepSeek V4 Pro, 7¢ |

Settings shows the same for your own library once Athena has answered a few requests, from their logged token counts.
With Jev, the picks request goes to Jev and costs almost nothing, so a Describe It costs a little over half as much.

Prices are November 2026 list prices. Gemini 4 Carbon's is the one from December 1, 2026, and DeepSeek's are its
peak-hour ones (American evenings); off-peak costs half. Every provider caches the library and the recent list for a
few minutes, so a second request with the same filters costs a fraction of the first. Thinking models are asked to
think little, since a viewer is waiting.

A local model costs nothing per request and keeps what people type at home. Point Athena at its OpenAI-style API
(Ollama's is `http://<machine>:11434/v1`, LM Studio's `http://<machine>:1234/v1`) and name the model; **Test** lists
the ones the server has, then tries the one you named. Reading a whole library in one go takes a capable model and a
fast machine, so expect slower answers than from the cloud.

Jev reads the same 600 titles as about 28K input tokens, at $0.042 per million with output free: about a thousandth of
a cent per request.

The status page's spend is an estimate from each request's token counts at list prices. Your provider's console has the
real bill.

## How it picks

With a TypeSafe key, library picks go to Jev, TypeSafe's decision model. It answers one yes-or-no question per title
("does this fit the request?") for the whole library at once, in about a quarter of a second instead of about eight.
Jev writes no text, so these picks come without a reason, and it leaves out the viewer's taste. Suggestions go to the
AI model, which names titles from what it knows and writes a reason for each; Jev can only choose from a list. Without
a TypeSafe key, or when Jev fails, the AI model makes the library picks too.

Get a key at [console.typesafe.ai](https://console.typesafe.ai/) and paste it under Settings → Jev, or set
`TYPESAFE_API_KEY`. Jev costs about a thousandth of a cent per request ([Models and cost](#models-and-cost)).

## API

The web page is at `/`; Ithaca uses the two routes below.

`GET /healthz` returns `{ ok, ready, model, provider, jev, service: "athena", server, serverTokens }`. `ready` is false until a Plex
server is chosen and an AI model or a TypeSafe key is set up, `provider` is where what the viewer types goes
(`anthropic`, `openai`, `gemini`, `xai`, `deepseek` or `local`), `jev` says whether library picks go to Jev, `service`
is how Ithaca recognizes Athena on port 8800, `server` is the machine identifier of the Plex server Athena checks
sign-ins against (null without one), and `serverTokens` says whether a viewer's token for that server is enough
(false until the owner has signed in to the web page with this version).

`POST /v1/pick`, with the viewer's token for that Plex server in `X-Plex-Token` (or, from older Ithaca versions, their
Plex account token):

```json
{
  "request": "something funny under two hours",
  "kind": "movie",
  "count": 9,
  "titles": [
    { "id": "1", "title": "Airplane!", "year": 1980, "genres": ["Comedy"], "minutes": 88,
      "contentRating": "PG", "scores": { "critics": 97, "audience": 89 },
      "seen": false, "rating": "loved" }
  ],
  "taste": { "loved": ["Heat (1995)"], "liked": [], "disliked": [], "recent": [] },
  "exclude": ["4", "17"],
  "suggest": 6,
  "discover": [
    { "id": "d1", "title": "The Cycle", "year": 2026, "genres": ["Horror"], "tmdb": 7.4,
      "overview": "A daughter unravels her father's dark past..." }
  ],
  "maxMinutes": 120,
  "genre": "Comedy"
}
```

`kind` is `movie` or `show`, and `minutes` is a show's typical episode. `scores` are Rotten Tomatoes `critics` and
`audience` in percent, and `imdb` and `tmdb` out of 10, as Plex lists them. `rating` is the viewer's own (`loved`,
`liked`, `disliked`). `exclude` lists ids already on screen. `suggest` asks for that many titles outside the library,
and `discover` is Seerr's trending and recent list for the model to choose from, since a model doesn't know the newest
releases. `maxMinutes` and `genre` are the screen's filters, which `titles` already meet. `count: 0` asks for
suggestions only, and `titles` can then be empty. Ithaca sends the picks and the suggestions as two requests at once:
Haiku 5.5 thinks before answering, and one combined answer takes 10 to 13 seconds, so the library picks don't wait for
the suggestions. The two count as one Describe It toward the daily limit.

The answer:

```json
{
  "picks": [{ "id": "1", "reason": "..." }],
  "suggestions": [{ "title": "Sunshine", "year": 2007, "discoverId": null, "reason": "..." }],
  "minimums": { "critics": 80, "audience": null, "imdb": null }
}
```

Picks come best fit first, only ids from `titles`; a pick from Jev has an empty `reason`. Jev's picks are the titles it
gives at least a 40% chance of fitting, so a narrow request can come back with fewer than `count`. Suggestions are
titles and years for Ithaca to look up on Seerr, with `discoverId` set when one came from `discover`. `minimums` is any
minimum rating the request asked for ("over 8 on Rotten Tomatoes" is a critics minimum of 80), so Ithaca can check the
scores itself.

Errors are `{ "error": "..." }`, written for Ithaca to show: 400 for a bad body, 401 for someone without access to the
Plex server, 429 past the daily limit, 503 before Athena is set up or without a key, 502 when the AI model, or Jev
with no AI model to fall back on, fails, or when plex.tv can't be reached to check a sign-in.

## Develop

```bash
bun install
bun run start      # :8800 for Ithaca, :8801 for Settings; settings and logs in ./data
bun test
bun run check
```

After cloning, turn on the versioned git hooks once (gitleaks checks every commit for secrets; `brew install gitleaks`):

```bash
git config core.hooksPath .githooks
```

Security issues: see [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE). Run it, change it, share it; if you offer a changed version to others over a network, share
its source too.
