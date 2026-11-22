<p align="center"><img src="unraid-icon.png" width="96" alt=""></p>

# Athena

**The AI companion for Ithaca for Plex.**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![gitleaks](https://github.com/inceptyon-labs/athena/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/inceptyon-labs/athena/actions/workflows/gitleaks.yml)

Athena answers Describe It in [Ithaca](https://inceptyon.io/ithaca/support), the Plex app for Apple TV, iPhone and
iPad. Describe It is part of Ithaca Pro: you type what you're in the mood for ("something funny under two hours") and
Ithaca picks from your library. Ithaca can do that on the device by itself. With Athena on your network, an AI model
you choose reads the request instead (Claude, GPT, Gemini, Grok, DeepSeek, or a model on your own machine): it
understands any phrasing, knows films your library doesn't have (so its To Request suggestions are better when Seerr is
connected), and gives a one-line reason for each pick.

Athena is a small server you run yourself, next to Plex and Seerr. Your household's Ithaca finds it on your home
network by itself; friends who use your Plex from outside reach it the way they reach your Seerr, at an HTTPS address.
Your API key stays on it, so the apps need none. It reads no library: Ithaca sends the titles that fit the
screen's filters with each request. Only people with access to your Plex server can use it.

## Install

Run Athena next to Plex and Seerr: on the machine Plex runs on, or another on the same home network. It works only with
a Plex server you own. You need Docker and either an API key from Anthropic, OpenAI, Google, xAI or DeepSeek, or a
model server on your network such as Ollama or LM Studio. Make the key in its own project or workspace with a monthly
spend limit.

### Unraid

In Community Apps, search for **Athena** and install it. Keep port 8800, and keep the data path
(`/mnt/user/appdata/athena`) unless you store app data elsewhere. Then open the WebUI.

### Docker Compose

```yaml
services:
  athena:
    image: ghcr.io/inceptyon-labs/athena:latest
    container_name: athena
    restart: unless-stopped
    ports:
      - "192.168.1.10:8800:8800" # this machine's home-network address
    volumes:
      - ./data:/data
    environment:
      TZ: America/New_York
```

`docker compose up -d`, then open `http://192.168.1.10:8800`. Publish the port on the machine's home-network address,
never `0.0.0.0` on a machine that faces the internet.

To build from source instead, clone this repository, `cp .env.example .env`, set `ATHENA_BIND` in it, and run
`docker compose up -d --build`.

## First run

1. Open Athena in a browser and **Sign in with Plex**, with the account that owns your Plex server. Plex asks you to
   approve the sign-in, then sends you back.
2. Choose your Plex server. Only people with access to it can use Athena, and only its owner can open Settings.
3. Choose an AI model: the provider, its API key and a tier (Fast, Balanced or Best). Each tier shows its price and
   about what a Describe It costs on it (below); Fast is the default and the cheapest. Press **Test** to send a small
   sample request through it, the way Ithaca's requests go, before you save.
4. Optionally add a TypeSafe key (below), a public address for friends away from home (below) and a daily limit per
   person. Save.

The status page then says whether Athena is ready and why not, how many Describe Its it answered today and this month,
an estimate of what that cost, how many each person used today and this month with what theirs cost, and the last 50 requests: who asked, what they typed,
the answer, the model and how long it took.

At home, Athena turns up in Ithaca by itself when it runs on the Plex machine with port 8800: Ithaca asks port 8800 on
the home-network address of each Plex server it reaches. Running elsewhere, enter its address in Ithaca under
Settings → Athena. Before the first request, Ithaca asks the viewer whether Describe It may use Athena, since what
they type goes on to the provider you chose (unless it's a local model).

Settings are kept in the data folder, `settings.json`, readable only by Athena; API keys are never shown back in full
or logged. The request log is `athena.db` in the same folder and keeps a little over a year. Environment variables
`PLEX_URL`, `ATHENA_PROVIDER` (`anthropic`, `openai`, `gemini`, `xai`, `deepseek` or `local`), `ATHENA_MODEL`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` and `TYPESAFE_API_KEY` win
over what's saved when they're set, and the browser shows those settings locked. `ATHENA_MODEL` alone also sets the
provider whose list has that model.

## Who can use it

Only people who can use your Plex server: you, your Plex Home profiles, and friends you share the library with. Ithaca
sends the viewer's Plex sign-in token with each request, and Athena asks plex.tv whether that account can reach your
server and which account it is (its id and name), so the status page lists people by name. Stop sharing with someone
in Plex and they lose Athena too. Answers are kept for ten minutes, by a hash of the token; tokens are never stored or
logged. Until a Plex server is chosen, Athena answers no one.

Anyone with access can sign in to the web page too; people other than the owner see only how many Describe Its they
used today. The daily limit is per person, off until you set one, and never applies to you. Only Describe Its that
the AI model or Jev answered count, and Ithaca's picks and suggestions for the same request count once. Past it, Ithaca shows
them "You've used Describe It 20 times today on Jason's Athena. It resets at midnight.", with your name as Plex shows
it.

The first person to sign in to a new Athena chooses its Plex server from the servers they own, so set it up right
after installing. To start over, stop Athena and delete `settings.json` from the data folder.

## Friends away from home

Without a public address, Athena is home-only. Friends who use your Plex from outside your home reach it the way they
reach your Seerr: at an HTTPS address, through a reverse proxy with a certificate in front of port 8800, such as Caddy:

```
athena.example.com {
	reverse_proxy 192.168.1.10:8800
}
```

Enter that address under Settings → Public address, then open **Share**. It shows:

- a link, `ithaca://athena?url=https%3A%2F%2Fathena.example.com`, to send in a message;
- a QR code of that link: scanned with an iPhone or iPad camera, it opens Ithaca with the address filled in;
- the address in large type, for Apple TV, where they type it in Ithaca under Settings → Athena.

Ithaca saves the address and asks its usual question before the first request. The web page works at that address too.
Friends' requests are on your API bill; set a daily limit if that worries you.

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
the ones the server has, then tries the one you named. Reading a whole library in one go takes a capable model and a fast machine, so expect slower
answers than from the cloud.

Jev reads the same 600 titles as about 28K input tokens, at $0.042 per million with output free: about a thousandth of
a cent per request.

The status page's spend is an estimate from each request's token counts at list prices. Your provider's console has the
real bill.

## How it picks

With a TypeSafe key, library picks go to Jev, a decision model that answers one yes-or-no question per title ("does
this fit the request?") for the whole library at once, in about a quarter of a second instead of about eight. Jev
writes no text, so these picks come without a reason, and it leaves out the viewer's taste. Suggestions go to the AI
model, which names titles from what it knows and writes a reason for each; Jev can only choose from a list. Without a
TypeSafe key, or when Jev fails, the AI model makes the library picks too.

## API

The web page is at `/`; Ithaca uses the two routes below.

`GET /healthz` returns `{ ok, ready, model, provider, jev, service: "athena", server }`. `ready` is false until a Plex
server is chosen and an AI model or a TypeSafe key is set up, `provider` is where what the viewer types goes (`anthropic`, `openai`,
`gemini`, `xai`, `deepseek` or `local`), `jev` says whether library picks go to Jev, `service` is how Ithaca recognises
Athena on port 8800, and `server` is the machine identifier of the Plex server Athena checks sign-ins against (null
without one).

`POST /v1/pick`, with the viewer's Plex account token in `X-Plex-Token`:

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
bun run start      # :8800, settings and the request log in ./data
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
