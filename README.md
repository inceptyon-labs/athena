# Mentor

Picks what to watch for [Ithaca](../ithaca), the Plex app. Ithaca's Pick Something
screen sends what the viewer typed ("something funny under two hours") with the
titles in their library that fit the screen's filters. Mentor asks Claude Haiku to
choose from that list and answers with ids and a one-line reason for each.

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
      "contentRating": "PG", "seen": false, "rating": "loved" }
  ],
  "taste": { "loved": ["Heat (1995)"], "liked": [], "disliked": [], "recent": [] },
  "exclude": ["4", "17"]
}
```

`kind` is `movie` or `show`, and `minutes` is a show's typical episode. `rating` is
the viewer's own (`loved`, `liked`, `disliked`). `exclude` lists ids already on
screen. The answer is `{ "picks": [{ "id": "1", "reason": "..." }] }`, best fit
first, only ids from `titles`. Errors are `{ "error": "..." }`: 400 for a bad body,
503 without a key, 502 when Claude fails.

## Cost

A 600-title library is about 25K input tokens. On Haiku 5.5 ($0.10 per million
input tokens) that is about a quarter of a cent per request. The library part of
the prompt is cached for five minutes, so a second request with the same filters
costs about a tenth of that. Each request logs its token counts.

## Run

```bash
bun install
ANTHROPIC_API_KEY=... bun run start   # :8800
bun test
```

Deployed to Uranus with `deploy` (compose, built on the box). The per-host `.env`
there holds `MENTOR_BIND`, `MENTOR_PORT` and `ANTHROPIC_API_KEY`; see `.env.example`.
Use a key from its own Claude Console workspace with a monthly spend limit.
