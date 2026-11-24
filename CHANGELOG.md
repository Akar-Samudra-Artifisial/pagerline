# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-24

### Added

- H1 — Glasses HUD: Idle, Inbox and Detail screens on G2, polling `GET /api/alerts` every 3 s.
- H1 — GitHub Actions (`workflow_run`, `issues`) and Sentry Internal Integration (`issue`) webhooks with
  HMAC verification, delivery deduplication and a 1 MB body limit.
- H3 — Device pairing: 6-character code on the glasses, operator approval at `/pair` with `ADMIN_SECRET`,
  device token delivered once, revocable; two-step unpair from Idle (long-press).
- H3 — Write actions limited to rerunning a GitHub workflow run and resolving a Sentry issue, through
  intent → Confirm (Cancel focused by default, one-time 60 s nonce) → result.
- H3 — Repo/project allowlists, per-device rate limits and an audit log viewable at `/audit`.
- H4 — Voice commands: long-press on Detail records up to 6 s (G2 mic, browser mic fallback), transcribed
  by Cartesia (English) via `POST /api/voice` and mapped by a rule-based parser to
  rerun/resolve/next/back/inbox/summary; rerun/resolve still require a manual Confirm.
- H5 — AI alert summary on Detail via `POST /api/alerts/{id}/summary` (`claude-haiku-5-5`, ≤ 240 chars,
  cached, 60 s refresh cooldown, heuristic fallback), with per-device and global quotas.

### Security

- No secrets in the glasses bundle; the static `DEVICE_TOKEN` is dev-only and read-only.
