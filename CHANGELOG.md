# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Pagerline logo (glasses + pulse mark) in `assets/brand/` (SVG icon/mark/wordmark, PNG 1024/512/256), used as
  the server app icon, the glasses favicon and the README header.

### Changed

- `GLASSES_ORIGINS=*` answers the glasses APIs with `Access-Control-Allow-Origin: *` (no credentials) for the
  Even Hub WebView, whose origin is undocumented; an exact origin list still works for local dev.
- `pnpm --filter @pagerline/glasses run pack` builds against `https://pagerline.vercel.app` and writes
  `apps/glasses/pagerline.ehpk` (`--sdk-ver 0.0.16`); the manifest network whitelist is HTTPS prod only and
  `min_app_version` is 2.2.10 (the SDK 0.0.16 floor).

### Security

- `GET /api/audit` sends CORS headers only for a valid device token; admin-secret and failed-auth responses
  are no longer readable cross-origin.

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
