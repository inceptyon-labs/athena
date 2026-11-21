# Athena: agent notes

Bun + TypeScript + Hono service that turns an Ithaca "Describe It" request into
picks from the viewer's own library with the AI model the owner chooses. What it does and its API are in
[README.md](README.md); this file holds only what the README doesn't say.

## Invariants

- **Ithaca is the only client, and the API is its contract.** `PickRequest` in
  `src/pick.ts` mirrors `AthenaPickRequest` in Ithaca
  (`Ithaca/Sources/Features/PickSomething/PickSomethingAthena.swift`). Change both
  together, and keep new fields optional so an older app keeps working.
- **The share link is Ithaca's contract too.** `shareLink` in `src/share.ts` makes `ithaca://athena?url=<address>`:
  scheme `ithaca`, host `athena`, one query item `url`, https only, nothing else. Ithaca parses it; change both together.
- **Picks only come from the list sent.** `cleanPicks` drops unknown, repeated and
  excluded ids; never return a title the request did not contain. Suggestions are
  free text that Ithaca checks against Seerr, so Athena only dedupes them.
- **The library and recent-list blocks are the cached prefix.** `SYSTEM`,
  `libraryText` and `discoverText` must stay byte-stable for the same input:
  nothing per request (time, exclusions, filters, the request itself) goes in
  them. Those go in `requestText`, after the breakpoints. The other providers
  (`src/compat.ts`) cache a repeated prompt start by themselves, so they get the
  same text in the same order, with `JSON_SHAPE` after `SYSTEM`.
- **One prompt, every provider.** Claude goes through Anthropic's SDK
  (`pick` in `src/pick.ts`); OpenAI, Gemini, Grok, DeepSeek and local servers
  through their OpenAI-style Chat Completions (`compat`). Both parse into
  `PickResult` and clean with the same `clean*` functions. The model lists,
  reasoning settings and output caps in `src/providers.ts` and the prices in
  `src/prices.ts` come from each provider's docs as of November 2026; check the
  docs again when changing them, since each provider names its parameters
  differently and some reject the others'.
- **Jev answers only library picks.** `answer` in `src/server.ts` sends a request
  with `suggest: 0` to Jev (`src/jev.ts`) when a TypeSafe key is set, and
  everything else to the chosen AI model. Jev picks have an empty `reason`, which
  Ithaca shows as none. A Jev failure falls back to the AI model, so a viewer
  still gets picks.
- **Jev's wording was tested on the real library.** The per-title question
  (`Movie: <line>` with the rules in `jevState`), the minimum questions and the
  0.4 fit cut-off each beat the alternatives tried on real requests. Re-test on
  real requests before changing them; one call takes about 1,000 titles, so
  `BATCH` is 500.
- **Only people with access to the Plex server.** `/v1/pick` needs the viewer's Plex account token
  (`X-Plex-Token`), and `PlexGate` (`src/plex.ts`) asks plex.tv's `/api/v2/resources` whether that account reaches
  the chosen server (its machine identifier, from Settings or from `PLEX_URL`'s `/identity`). Never check against the
  Plex server itself: Plex lets home-network addresses in without auth, so it accepts any token from there. Until a
  server is chosen, `/v1/pick` answers 503. Tokens are kept only as SHA-256 hashes, never logged.
- **Settings: env wins, secrets stay put.** `src/settings.ts` keeps `data/settings.json` (mode 600, atomic writes);
  each env var that is set overrides its field and the UI shows it locked. `Live` (`src/live.ts`) is read on every
  request, so saving applies without a restart. Keys are rendered only through `mask`, never in full, never logged.
  Web sessions (`src/sessions.ts`) hold the Plex token in memory only.
- **Only the server's owner changes settings.** Owner means plex.tv lists the server with `owned: true` for that
  account. Before any server is chosen, whoever signs in first sets Athena up, from servers they own. The daily limit
  never applies to the owner; Ithaca's paired picks and suggestions requests (same text within two minutes) count once.
- **The web UI is small on purpose.** Hono JSX rendered on the server (`src/web.tsx`), one stylesheet and one script
  in `public/`. Design context is in `PRODUCT.md`; the navy and gold belong to the header and icon only.
- **Images are for other people.** `.github/workflows/image.yml` publishes `ghcr.io/inceptyon-labs/athena` on a `v*`
  tag, for Unraid Community Apps (`unraid/athena.xml`) and Compose users. Uranus never pulls it: it builds from source
  with `deploy`.
- **The repo is public (AGPL-3.0).** No hosts, addresses or keys in it; per-host
  values live in the box's `.env`.

## Verify

`bun run check` and `bun test`. A live check: `curl -s http://<host>:8800/healthz`, which names the Plex server it
checks sign-ins against, and the status page at `/`.
