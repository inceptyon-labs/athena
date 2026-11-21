<p align="center"><img src="unraid-icon.png" width="96" alt=""></p>

# Athena

**The AI companion for Ithaca for Plex.**

Athena answers Describe It in [Ithaca](https://inceptyon.io/ithaca/support), the Plex app for Apple TV, iPhone and
iPad. Describe It is part of Ithaca Pro: you type what you're in the mood for ("something funny under two hours") and
Ithaca picks from your library. Ithaca can do that on the device by itself. With Athena on your network, Claude reads
the request instead: it understands any phrasing, knows films your library doesn't have (so its To Request suggestions
are better when Seerr is connected), and gives a one-line reason for each pick.

Athena is a small server you run yourself, next to Plex and Seerr. Your household's Ithaca finds it on your home
network by itself; friends who use your Plex from outside reach it the way they reach your Seerr, at an HTTPS address.
Your Anthropic API key stays on it, so the apps need none. It reads no library: Ithaca sends the titles that fit the
screen's filters with each request. Only people with access to your Plex server can use it.

## Install

Run Athena next to Plex and Seerr: on the machine Plex runs on, or another on the same home network. It works only with
a Plex server you own. You need Docker and an Anthropic API key; make the key in its own
[Claude Console](https://console.anthropic.com) workspace with a monthly spend limit.

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
3. Paste your Anthropic API key and press **Test key**. Haiku 5.5 is the default model and the cheapest.
4. Optionally add a TypeSafe key (below), a public address for friends away from home (below) and a daily limit per
   person. Save.

The status page then says whether Athena is ready and why not, how many Describe Its it answered today and this month,
an estimate of what that cost, how many each person used today, and the last 50 requests: who asked, what they typed,
the answer, the model and how long it took.

At home, Athena turns up in Ithaca by itself when it runs on the Plex machine with port 8800: Ithaca asks port 8800 on
the home-network address of each Plex server it reaches. Running elsewhere, enter its address in Ithaca under
Settings → Athena. Before the first request, Ithaca asks the viewer whether Describe It may use Athena, since what
they type goes on to Anthropic.

Settings are kept in the data folder, `settings.json`, readable only by Athena; API keys are never shown back in full
or logged. The request log is `athena.db` in the same folder and keeps a little over a year. Environment variables
`PLEX_URL`, `ANTHROPIC_API_KEY`, `ATHENA_MODEL` and `TYPESAFE_API_KEY` win over what's saved when they're set, and the
browser shows those settings locked.

## Who can use it

Only people who can use your Plex server: you, your Plex Home profiles, and friends you share the library with. Ithaca
sends the viewer's Plex sign-in token with each request, and Athena asks plex.tv whether that account can reach your
server and which account it is (its id and name), so the status page lists people by name. Stop sharing with someone
in Plex and they lose Athena too. Answers are kept for ten minutes, by a hash of the token; tokens are never stored or
logged. Until a Plex server is chosen, Athena answers no one.

Anyone with access can sign in to the web page too; people other than the owner see only how many Describe Its they
used today. The daily limit is per person, off until you set one, and never applies to you. Only Describe Its that
Claude or Jev answered count, and Ithaca's picks and suggestions for the same request count once. Past it, Ithaca shows
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
Friends' requests are on your Anthropic bill; set a daily limit if that worries you.

## Cost

A 600-title library is about 25K input tokens, and the recent list about 4K more. On Haiku 5.5 ($0.10 per million
input tokens) that is about a quarter of a cent per request. The library and the recent list are cached for five
minutes, so a second request with the same filters costs about a tenth of that. Sonnet 5.5 costs about 20 times as
much as Haiku, Opus 5.5 about 40.

Jev reads the same 600 titles as about 28K input tokens, at $0.042 per million with output free: about a thousandth of
a cent per request.

The status page's spend is an estimate from each request's token counts at list prices. Your Claude Console has the
real bill.

## How it picks

With a TypeSafe key, library picks go to Jev, a decision model that answers one yes-or-no question per title ("does
this fit the request?") for the whole library at once, in about a quarter of a second instead of about eight. Jev
writes no text, so these picks come without a reason, and it leaves out the viewer's taste. Suggestions go to Claude,
which names titles from what it knows and writes a reason for each; Jev can only choose from a list. Without a
TypeSafe key, or when Jev fails, Claude makes the library picks too.

## API

The web page is at `/`; Ithaca uses the two routes below.

`GET /healthz` returns `{ ok, ready, model, jev, service: "athena", server }`. `ready` is false until a Plex server is
chosen and a key is set, `jev` says whether library picks go to Jev, `service` is how Ithaca recognises Athena on port
8800, and `server` is the machine identifier of the Plex server Athena checks sign-ins against (null without one).

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
and `discover` is Seerr's trending and recent list for Claude to choose from, since Haiku doesn't know the newest
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
Plex server, 429 past the daily limit, 503 before Athena is set up or without a key, 502 when Claude, or Jev with no
Claude to fall back on, fails, or when plex.tv can't be reached to check a sign-in.

## Develop

```bash
bun install
bun run start      # :8800, settings and the request log in ./data
bun test
bun run check
```

## License

[AGPL-3.0](LICENSE). Run it, change it, share it; if you offer a changed version to others over a network, share
its source too.
