# Mentor: agent notes

Bun + TypeScript + Hono service that turns an Ithaca "Describe It" request into
picks from the viewer's own library with Claude. What it does and its API are in
[README.md](README.md); this file holds only what the README doesn't say.

## Invariants

- **Ithaca is the only client, and the API is its contract.** `PickRequest` in
  `src/pick.ts` mirrors `MentorPickRequest` in Ithaca
  (`Ithaca/Sources/Features/PickSomething/PickSomethingMentor.swift`). Change both
  together, and keep new fields optional so an older app keeps working.
- **Picks only come from the list sent.** `cleanPicks` drops unknown, repeated and
  excluded ids; never return a title the request did not contain.
- **The library block is the cached prefix.** `SYSTEM` and `libraryText` must stay
  byte-stable for the same input: nothing per request (time, exclusions, the
  request itself) goes in them. Those go in `requestText`, after the breakpoint.
- **LAN only, no auth.** The port is published on the LAN address alone. Anyone
  who can reach it spends the key, so the key's workspace carries the spend limit.

## Verify

`bun run check` and `bun test`. A live check needs the key:
`curl -s http://192.168.2.222:8800/healthz`.
