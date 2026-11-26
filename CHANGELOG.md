# Changelog
All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Answers Ithaca's Describe It (`POST /v1/pick`) from the viewer's own Plex library, with suggestions to request
  through Seerr; Jev for library picks with a TypeSafe key.
- Only people with access to the owner's Plex server, checked against plex.tv.
- Web UI: Plex sign-in, settings in the browser, a status page with per-person counts and estimated spend.
- AI providers: Anthropic, OpenAI, Google, xAI, DeepSeek and local servers (Ollama, LM Studio), each with Fast,
  Balanced and Best tiers, prices per Describe It, and a Test button.
- Friends away from home: a public address, an `ithaca://` share link and QR code, a per-person daily limit.
- Docker image workflow, Unraid template and Compose file.
- Settings, Automations and setup on their own port, 8801, which opens them only from the home network, so a proxy
  or tunnel for friends never puts the keys on the internet; the owner's status page and Share open anywhere.
  Settings → Settings from anywhere opens them on 8800 too, behind Plex sign-in.
- Each API key can be read from a file, as `<NAME>_FILE`, for Docker secrets or a vault's agent.

### Fixed
- The daily limit held against requests sent at once, the same words sent over and over, and answers the model gave
  that Athena couldn't use (now counted, with their cost on the status page).
- Settings and the owner's exemption from the limit are for the Plex account that set Athena up, not every account
  plex.tv lists as owning the server.
- Settings' error banner shows only Athena's own messages; the web UI sends a Content-Security-Policy and `nosniff`.
- Every web form carries a per-sign-in token, a form from a page with no origin is refused, sign-ins last 7 days
  instead of 30, and forwarded host and protocol headers count only from a proxy on the home network.
