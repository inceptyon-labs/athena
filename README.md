# Mentor

Picks what to watch for [Ithaca](../ithaca), the Plex app. Ithaca's Pick Something
screen sends what the viewer typed ("something funny under two hours") with the
titles in their library that fit the screen's filters. Mentor asks Claude Haiku to
choose from that list and answers with ids and a one-line reason for each. With
Seerr connected, Ithaca also asks for titles the household doesn't have, which it
shows as a To Request row.

The Anthropic API key lives only here, so the apps on the TVs and phones need no
key or cloud account. Mentor keeps no state and never talks to Plex: Ithaca sends
everything it needs, so each Plex Home profile gets picks from its own library and
watch history.

## API

`GET /healthz` returns `{ ok, ready, model }`. `ready` is false until a key is set.

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
and `genre` are the screen's filters, which `titles` already meet. `titles` can be
empty when `suggest` is set.

The answer:

```json
{
  "picks": [{ "id": "1", "reason": "..." }],
  "suggestions": [{ "title": "Sunshine", "year": 2007, "discoverId": null, "reason": "..." }],
  "minimums": { "critics": 80, "audience": null, "imdb": null }
}
```

Picks come best fit first, only ids from `titles`. Suggestions are titles and
years for Ithaca to look up on Seerr, with `discoverId` set when one came from
`discover`. `minimums` is any minimum rating the request asked for ("over 8 on
Rotten Tomatoes" is a critics minimum of 80), so Ithaca can check the scores
itself. Errors are `{ "error": "..." }`: 400 for a bad body, 503 without a key, 502
when Claude fails.

## Cost

A 600-title library is about 25K input tokens, and the recent list about 4K more.
On Haiku 5.5 ($0.10 per million input tokens) that is about a quarter of a cent
per request. The library and the recent list are cached for five minutes, so a
second request with the same filters costs about a tenth of that. Each request
logs its token counts.

## Run

```bash
bun install
ANTHROPIC_API_KEY=... bun run start   # :8800
bun test
```

Deployed to Uranus with `deploy` (compose, built on the box). The per-host `.env`
there holds `MENTOR_BIND`, `MENTOR_PORT` and `ANTHROPIC_API_KEY`; see `.env.example`.
Use a key from its own Claude Console workspace with a monthly spend limit.
