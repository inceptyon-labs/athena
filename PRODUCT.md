# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **The Plex server owner**, who installs Athena next to Plex and Seerr (Unraid or Docker Compose), sets it up once in a browser, often on a phone, and later glances at whether it is ready, how much it is used and what it costs.
- **People with access to that Plex server** (Plex Home profiles, friends the library is shared with), who use Athena through Ithaca's Describe It. They may sign in to the web UI too, where they see only their own use against the daily limit.

## Product Purpose

Athena answers Describe It in Ithaca, the Plex app for Apple TV, iPhone and iPad: a viewer types what they are in the mood for, and the AI model the owner chose (Claude, GPT, Gemini, Grok, DeepSeek or a local model; Jev for library picks) chooses from the viewer's own library and suggests titles to request. Athena holds the API key so the apps need none, and lets in only people with access to the owner's Plex server. Success: a stranger installs it and gets it working from the browser without editing files, and the owner can see at a glance that it works and what it costs.

## Positioning

The optional, self-hosted companion to Ithaca for Plex. It runs on the owner's own machine with the owner's own API key; nothing goes through Inceptyon Labs.

## Operating Context

- Installed from Unraid Community Apps or Docker Compose; the web UI shares port 8800 with the API Ithaca calls (`/healthz`, `/v1/pick`).
- Sign-in is Plex's own PIN flow. Only the owner of the chosen Plex server may change settings.
- The household's Ithaca finds it on port 8800 by itself. Friends away from home reach it through an HTTPS reverse proxy the owner sets up, the way they reach the owner's Seerr; without one it is home-only.

## Capabilities and Constraints

- Settings: Plex server (from the owner's plex.tv servers), AI provider (Anthropic, OpenAI, Google, xAI, DeepSeek or a local server) with its key or address, a tier (Fast, Balanced, Best) with about what a request costs, and a test; optional TypeSafe key for Jev, public address, per-person daily limit. Environment variables win over saved settings.
- Status: ready or not and why, requests today and this month, estimated spend from logged token counts, today's count per person, the last 50 requests.
- Share (owner only, once the public address is set): an `ithaca://athena?url=` link to copy, its QR code for an iPhone or iPad camera, and the address in large type for Apple TV.
- Secrets are never shown in full or logged. Small and fast: server-rendered, minimal JavaScript, no frontend framework.
- The API is Ithaca's contract and does not change shape.

## Brand Commitments

- Name: Athena. Its mark refers to Athena of the Odyssey subtly; it is a sibling of Ithaca's icon (warm gold `#EBAE41` on a navy gradient `#1B3A68` to `#081224`).
- Navy and gold belong to the logo and icon. The UI stays neutral, in the spirit of Ithaca's "native vibes, not orange".
- Plain voice, no marketing tone. Never reads as an official product of Plex or of any AI provider.

## Evidence on Hand

- No users, reviews or usage numbers beyond the owner's own server; don't invent any.
- Cost figures in the README come from measured token counts on a real library.

## Product Principles

1. Working without editing files: everything a stranger needs is in the browser.
2. Only people the owner already shares Plex with.
3. Glance and go: ready or not, use, and cost, readable in one look.
4. The owner's key, the owner's machine: secrets stay put and are never shown back.
