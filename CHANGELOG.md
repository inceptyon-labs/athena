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
