# Mentor

Picks what to watch for [Ithaca](../ithaca), the Plex app. Ithaca's Pick Something
screen sends what the viewer typed ("something funny under two hours") with the
titles in their library that fit the screen's filters. Mentor chooses from that
list and answers with ids. With Seerr connected, Ithaca also asks for titles the
household doesn't have, which it shows as a To Request row.

Two models do the choosing. With a TypeSafe key, library picks go to
[Jev](https://typesafe.ai), a decision model that answers one yes-or-no question
per title ("does this fit the request?") for the whole library at once, in about
a quarter of a second. Jev writes no text, so these picks come without a reason,
and it leaves out the viewer's taste.
Suggestions go to Claude Haiku, which names titles from what it knows and writes
a one-line reason for each; Jev can only choose from a list. Without a TypeSafe
key, or when Jev fails, Claude makes the library picks too, with reasons, in
about eight seconds.

The Anthropic API key lives only here, so the apps on the TVs and phones need no
key or cloud account. Mentor keeps no state and never talks to Plex: Ithaca sends
everything it needs, so each Plex Home profile gets picks from its own library and
watch history.

## API

`GET /healthz` returns `{ ok, ready, model, jev, service: "mentor" }`. `ready` is
false until a key is set, and `jev` says whether library picks go to Jev. Ithaca finds Mentor without an address typed in by asking
port 8800 on the home-network address of each Plex server it reaches, and
`service` is how it knows the answer is Mentor. Keep the port at 8800 on the
Plex machine for that to work.

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
itself. Errors are `{ "error": "..." }`: 400 for a bad body, 503 without a key, 502
when Claude, or Jev with no Claude to fall back on, fails.

## Cost

A 600-title library is about 25K input tokens, and the recent list about 4K more.
On Haiku 5.5 ($0.10 per million input tokens) that is about a quarter of a cent
per request. The library and the recent list are cached for five minutes, so a
second request with the same filters costs about a tenth of that.

Jev reads the same 600 titles as about 28K input tokens, at $0.042 per million
with output free: about a thousandth of a cent per request. Each request logs its
token counts and which model answered.

## Run

```bash
bun install
ANTHROPIC_API_KEY=... bun run start   # :8800
bun test
```

Deployed to Uranus with `deploy` (compose, built on the box). The per-host `.env`
there holds `MENTOR_BIND`, `MENTOR_PORT`, `ANTHROPIC_API_KEY` and
`TYPESAFE_API_KEY`; see `.env.example`.
Use a key from its own Claude Console workspace with a monthly spend limit.
