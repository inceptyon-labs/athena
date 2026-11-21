# Athena

Athena answers Describe It in [Ithaca](https://inceptyon.io/ithaca/support), the Plex app for Apple TV, iPhone and
iPad. Describe It is part of Ithaca Pro: you type what you're in the mood for ("something funny under two hours") and
Ithaca picks from your library. Ithaca does that on the device by itself. With Athena on your network, Claude reads the
request instead: it understands any phrasing, knows films your library doesn't have (so its To Request suggestions are
better when Seerr is connected), and gives a one-line reason for each pick.

Athena is a small server you run yourself, next to Plex. Your Anthropic API key stays on it, so the apps need no key.
It keeps no state and reads no library: Ithaca sends the titles that fit the screen's filters with each request.

## Set it up

You need Docker, the machine your Plex server runs on (or one beside it), and an Anthropic API key. Make the key in its
own [Claude Console](https://console.anthropic.com) workspace with a monthly spend limit.

```bash
git clone https://github.com/inceptyon-labs/athena.git && cd athena
cp .env.example .env    # then fill it in
docker compose up -d --build
curl http://<ATHENA_BIND>:8800/healthz
```

In `.env`:

| Setting | |
| --- | --- |
| `ATHENA_BIND` | This machine's home-network address, the one Ithaca reaches Plex on. Never `0.0.0.0` on a machine that faces the internet. |
| `ATHENA_PORT` | Keep `8800`. |
| `PLEX_URL` | Your Plex server as Athena reaches it, such as `http://192.168.1.10:32400`. |
| `ANTHROPIC_API_KEY` | Your key. |
| `ATHENA_MODEL` | Optional. Defaults to `claude-haiku-5-5`. |
| `TYPESAFE_API_KEY` | Optional. Library picks from [Jev](https://typesafe.ai) in a quarter of a second instead of about eight (below). |

Ithaca finds Athena by itself when it runs on the Plex machine with port 8800: it asks port 8800 on the home-network
address of each Plex server it reaches. Running elsewhere, enter its address in Ithaca under Settings → Athena. Before
the first request, Ithaca asks the viewer whether Describe It may use Athena, since what they type goes on to
Anthropic.

## Who can use it

Only people who can use your Plex server: you, your Plex Home profiles, and friends you share the library with. Ithaca
sends the viewer's Plex sign-in token with each request, and Athena asks plex.tv whether that account can reach the
server at `PLEX_URL`. Stop sharing with someone in Plex and they lose Athena too. Answers are kept for ten minutes, by a
hash of the token. Without `PLEX_URL`, anyone who can reach Athena can spend your key.

Friends who use your Plex from outside your home need Athena at an HTTPS address they can reach, such as a reverse
proxy with a certificate in front of port 8800. They enter that address once under Settings → Athena. Their requests
are on your Anthropic bill (see Cost).

## How it picks

With a TypeSafe key, library picks go to Jev, a decision model that answers one yes-or-no question per title ("does
this fit the request?") for the whole library at once. Jev writes no text, so these picks come without a reason, and it
leaves out the viewer's taste. Suggestions go to Claude, which names titles from what it knows and writes a reason for
each; Jev can only choose from a list. Without a TypeSafe key, or when Jev fails, Claude makes the library picks too.

## API

`GET /healthz` returns `{ ok, ready, model, jev, service: "athena", server }`. `ready` is false until a key is set,
`jev` says whether library picks go to Jev, `service` is how Ithaca recognises Athena on port 8800, and `server` is the
machine identifier of the Plex server at `PLEX_URL` (null without one).

`POST /v1/pick`

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

`kind` is `movie` or `show`, and `minutes` is a show's typical episode. `scores` are
Rotten Tomatoes `critics` and `audience` in percent, and `imdb` and `tmdb` out of
10, as Plex lists them. `rating` is the viewer's own (`loved`, `liked`,
`disliked`). `exclude` lists ids already on screen. `suggest` asks for that many
titles outside the library, and `discover` is Seerr's trending and recent list for
Claude to choose from, since Haiku doesn't know the newest releases. `maxMinutes`
and `genre` are the screen's filters, which `titles` already meet. `count: 0` asks
for suggestions only, and `titles` can then be empty. Ithaca sends the picks and
the suggestions as two requests at once: Haiku 5.5 thinks before answering, and
one combined answer takes 10 to 13 seconds, so the library picks don't wait for
the suggestions.

The answer:

```json
{
  "picks": [{ "id": "1", "reason": "..." }],
  "suggestions": [{ "title": "Sunshine", "year": 2007, "discoverId": null, "reason": "..." }],
  "minimums": { "critics": 80, "audience": null, "imdb": null }
}
```

Picks come best fit first, only ids from `titles`; a pick from Jev has an empty
`reason`. Jev's picks are the titles it gives at least a 40% chance of fitting, so
a narrow request can come back with fewer than `count`. Suggestions are titles and
years for Ithaca to look up on Seerr, with `discoverId` set when one came from
`discover`. `minimums` is any minimum rating the request asked for ("over 8 on
Rotten Tomatoes" is a critics minimum of 80), so Ithaca can check the scores
itself. Errors are `{ "error": "..." }`: 400 for a bad body, 401 for someone without access to
the Plex server, 503 without a key, 502 when Claude, or Jev with no Claude to fall back on, fails, or when Plex
can't be reached to check a sign-in.

Every `POST /v1/pick` carries the viewer's Plex account token in `X-Plex-Token` when `PLEX_URL` is set.

## Cost

A 600-title library is about 25K input tokens, and the recent list about 4K more.
On Haiku 5.5 ($0.10 per million input tokens) that is about a quarter of a cent
per request. The library and the recent list are cached for five minutes, so a
second request with the same filters costs about a tenth of that.

Jev reads the same 600 titles as about 28K input tokens, at $0.042 per million
with output free: about a thousandth of a cent per request. Each request logs its
token counts and which model answered.

## Develop

```bash
bun install
PLEX_URL=http://192.168.1.10:32400 ANTHROPIC_API_KEY=... bun run start   # :8800
bun test
bun run check
```

## License

[AGPL-3.0](LICENSE). Run it, change it, share it; if you offer a changed version to others over a network, share
its source too.
