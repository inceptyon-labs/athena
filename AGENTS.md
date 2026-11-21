# Athena: agent notes

Bun + TypeScript + Hono service that turns an Ithaca "Describe It" request into
picks from the viewer's own library with Claude. What it does and its API are in
[README.md](README.md); this file holds only what the README doesn't say.

## Invariants

- **Ithaca is the only client, and the API is its contract.** `PickRequest` in
  `src/pick.ts` mirrors `AthenaPickRequest` in Ithaca
  (`Ithaca/Sources/Features/PickSomething/PickSomethingAthena.swift`). Change both
  together, and keep new fields optional so an older app keeps working.
- **Picks only come from the list sent.** `cleanPicks` drops unknown, repeated and
  excluded ids; never return a title the request did not contain. Suggestions are
  free text that Ithaca checks against Seerr, so Athena only dedupes them.
- **The library and recent-list blocks are the cached prefix.** `SYSTEM`,
  `libraryText` and `discoverText` must stay byte-stable for the same input:
  nothing per request (time, exclusions, filters, the request itself) goes in
  them. Those go in `requestText`, after the breakpoints.
- **Jev answers only library picks.** `answer` in `src/server.ts` sends a request
  with `suggest: 0` to Jev (`src/jev.ts`) when `TYPESAFE_API_KEY` is set, and
  everything else to Claude. Jev picks have an empty `reason`, which Ithaca shows
  as none. A Jev failure falls back to Claude, so a viewer still gets picks.
- **Jev's wording was tested on the real library.** The per-title question
  (`Movie: <line>` with the rules in `jevState`), the minimum questions and the
  0.4 fit cut-off each beat the alternatives tried on real requests. Re-test on
  real requests before changing them; one call takes about 1,000 titles, so
  `BATCH` is 500.
- **Only people with access to the Plex server.** With `PLEX_URL` set, `/v1/pick`
  needs the viewer's Plex account token (`X-Plex-Token`), and `PlexGate`
  (`src/plex.ts`) asks plex.tv's `/api/v2/resources` whether that account reaches
  the server at `PLEX_URL`. Never check against the Plex server itself: Plex lets
  home-network addresses in without auth, so it accepts any token from there.
  Tokens are kept only as SHA-256 hashes, never logged.
- **The repo is public (AGPL-3.0).** No hosts, addresses or keys in it; per-host
  values live in the box's `.env`.

## Verify

`bun run check` and `bun test`. A live check needs the key:
`curl -s http://<host>:8800/healthz`, which names the Plex server it checks
sign-ins against.
