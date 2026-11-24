# Pagerline

Heads-up on-call HUD for **Even Realities G2** glasses. CI failures (GitHub Actions) and Sentry
issues land on your glasses as they happen; you can read an AI summary, rerun a failed workflow or
resolve a Sentry issue (always behind an explicit confirm step) and drive it by voice, without
reaching for your phone.

Built for the DoraHacks "Heads Up" hackathon (track: **AI Assistants & Work**).
Live server: <https://pagerline.vercel.app>

> **Status: tested in the Even Hub simulator only.** The developer does not own G2 glasses. Real
> ring/touchpad input and the real G2 microphone have not been tested on hardware. See
> [Limitations](#limitations).

## Features

- **Glasses UI** (text only, 576×288): **Idle** (status header + 3 latest alerts) → **Inbox** (list) →
  **Detail** (alert + AI summary). The app polls `GET /api/alerts?since=` every 3 s and catches up on
  foreground enter. New alerts while the inbox is open are counted ("+N new") instead of moving the list.
- **Webhook ingest**: GitHub (`workflow_run` completed with failure, `issues` opened/reopened) and Sentry
  Internal Integration (`issue`, plus `event_alert`/`error`). HMAC-verified, deduplicated, body limit 1 MB.
- **Device pairing**: the glasses show a 6-character code; an operator approves it at `/pair` with
  `ADMIN_SECRET`. The device token is delivered once, stored only as a hash, and can be revoked.
- **Write actions** (only two): rerun a GitHub Actions workflow run, resolve a Sentry issue.
  Flow: intent → **Confirm** screen (focus defaults to *Cancel*, one-time nonce valid 60 s) → result.
  Server-side allowlists for repos/projects, rate limits, and an audit log viewable at `/audit`.
- **Voice commands**: long-press on Detail records up to 6 s (G2 mic, browser mic as fallback) →
  `POST /api/voice` → Cartesia speech-to-text (English) → **rule-based** parser (no LLM) → one intent:
  `rerun | resolve | next | back | inbox | summary`. Voice `rerun`/`resolve` only opens the Confirm
  screen; confirming is always a manual tap.
- **AI summary** on Detail via `POST /api/alerts/{id}/summary`: model `claude-haiku-5-5`, plain text
  ≤ 240 chars, no tools, cached in the database, refresh cooldown 60 s, heuristic (non-AI) fallback when
  the AI is unavailable or rate limited.

### Gestures

| Screen | Tap | Double-tap | Swipe | Long-press |
| --- | --- | --- | --- | --- |
| Idle | open Inbox | exit app | — | unpair prompt (Cancel/Confirm) |
| Inbox | open row (row 0 = "< Back") | back to Idle | move selection | — |
| Detail | back to Inbox | action menu | up = Inbox, down = next alert | record voice command |
| Voice (listening) | stop & send | cancel | — | stop & send |
| Confirm | Cancel / Confirm row | back to actions | move selection | — |

## Demo / screens

Screenshots were taken from the Even Hub simulator during development; they are kept locally and are
not part of this repository. The demo video is linked from the hackathon submission.

## Architecture

```
 GitHub Actions ──workflow_run/issues──┐  (HMAC X-Hub-Signature-256)
 Sentry Integration ──issue/alerts─────┤  (HMAC Sentry-Hook-Signature)
                                       ▼
                         apps/server (Next.js route handlers, Vercel)
                           ├─ webhooks → dedup → alerts      ┐
                           ├─ pairing / devices / nonces     ├─ Postgres (Neon) via Drizzle
                           ├─ actions → GitHub / Sentry API  │
                           ├─ audit log + quotas             ┘
                           ├─ /api/voice  → Cartesia STT → rule parser
                           └─ /api/alerts/{id}/summary → Anthropic (claude-haiku-5-5)
                                       ▲
               HTTPS, Bearer device token (polling every 3 s)
                                       │
 apps/glasses (Vite + TS, Even Hub SDK 0.0.16) ── runs in the Even app WebView ── G2 display/input/mic
```

```
apps/glasses      Vite + TypeScript plugin using @evenrealities/even_hub_sdk
apps/server       Next.js (App Router) API + minimal pages (/pair, /audit), Drizzle + Postgres
packages/shared   Shared types (Alert, actions, voice/summary responses)
scripts/demo-seed Sends signed fake GitHub + Sentry webhooks; --selftest checks the API end to end
```

## Quick start (local)

Requirements: Node 22+, pnpm 11, Postgres 16+, `@evenrealities/evenhub-simulator`.

```sh
pnpm install
npm i -g @evenrealities/evenhub-simulator
```

### 1. Postgres (port 5433)

With Podman (choose your own password and put it in `DATABASE_URL`):

```sh
podman run -d --name pagerline-pg -p 5433:5432 \
  -e POSTGRES_USER=pagerline -e POSTGRES_PASSWORD=<password> -e POSTGRES_DB=pagerline \
  docker.io/library/postgres:16
```

or a throwaway local cluster (Homebrew `postgresql@17`), data in `.pgdata/` (gitignored):

```sh
PGB=/opt/homebrew/opt/postgresql@17/bin
$PGB/initdb -D .pgdata -U pagerline --auth=trust
$PGB/pg_ctl -D .pgdata -o "-p 5433 -k /tmp" -l .logs/postgres.log start
$PGB/createdb -h localhost -p 5433 -U pagerline pagerline
```

### 2. Server (port 3300)

```sh
cp apps/server/.env.example apps/server/.env.local   # fill in values (secrets: openssl rand -hex 32)
pnpm db:migrate                                       # applies apps/server/drizzle/*.sql
pnpm dev:server                                       # http://localhost:3300
pnpm seed                                             # signed demo webhooks
pnpm --filter @pagerline/demo-seed seed --selftest    # also checks 401, dedup, actions, voice/summary mocks
```

### 3. Glasses app + simulator

```sh
cp apps/glasses/.env.example apps/glasses/.env.local  # VITE_API_BASE=http://localhost:3300
pnpm dev:glasses                                      # http://localhost:5173
pnpm --filter @pagerline/glasses simulate             # evenhub-simulator on :5173
```

On first start the glasses show a pairing code; approve it at `http://localhost:3300/pair` (see
[Pairing](#pairing)). For a quick read-only dev session you can instead open the app once with
`?token=<DEVICE_TOKEN>`; the token is stored via `bridge.setLocalStorage` and stripped from the URL. It is
never compiled into the bundle.

**Mock mode**: leave `VITE_API_BASE` empty or set `VITE_MOCK=1` and the app runs fully offline on built-in
demo alerts (no server, no pairing).

Package for Even Hub: `pnpm --filter @pagerline/glasses pack` (produces an `.ehpk`).

## Environment

All server variables are listed, with comments, in [`apps/server/.env.example`](apps/server/.env.example)
(placeholders only). Copy it to `apps/server/.env.local`; never commit real values.

| Group | Variables |
| --- | --- |
| Database | `DATABASE_URL` |
| Glasses access | `GLASSES_ORIGINS` (CORS), `DEVICE_TOKEN` (dev only, read-only, ignored in production) |
| Admin | `ADMIN_SECRET` (for `/pair`, `/audit`, `/api/admin/*`) |
| Webhooks | `GITHUB_WEBHOOK_SECRET`, `SENTRY_CLIENT_SECRET` |
| Actions | `GITHUB_ACTIONS_TOKEN`, `GITHUB_ALLOWED_REPOS`, `SENTRY_API_TOKEN`, `SENTRY_ORG`, `SENTRY_ALLOWED_PROJECTS`, `ACTIONS_DRY_RUN`, `ACTION_NONCE_TTL_SECONDS` |
| Pairing | `PAIR_RATE_LIMIT` |
| Voice / AI | `CARTESIA_API_KEY`, `ANTHROPIC_API_KEY`, `VOICE_STT_MOCK`, `SUMMARY_AI_MOCK` (mocks ignored in production) |
| Demo seed | `SERVER_URL` |

Glasses app: `VITE_API_BASE`, `VITE_MOCK` (see `apps/glasses/.env.example`). No secret is ever bundled.

## Deploy (Vercel + Neon)

1. Create a Neon Postgres database and run the migrations against it:
   `DATABASE_URL=<neon url> pnpm db:migrate`.
2. Create a Vercel project with root directory `apps/server` (framework: Next.js, pnpm workspace).
3. Set the environment variables above in Vercel (do **not** set `DEVICE_TOKEN`, `VOICE_STT_MOCK`,
   `SUMMARY_AI_MOCK` in production; they are ignored there anyway). Set `GLASSES_ORIGINS` to the origin(s)
   the glasses WebView uses.
4. Build the glasses app with `VITE_API_BASE=https://<your-app>.vercel.app` and add that URL to the
   `network` whitelist in `apps/glasses/app.json`.

## Webhook setup

**GitHub** (repo or org → Settings → Webhooks): payload URL `https://<server>/api/webhooks/github`,
content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, events *Workflow runs* and *Issues*.
For reruns, create a token with Actions write access on the allowed repos (`GITHUB_ACTIONS_TOKEN`) and
list them in `GITHUB_ALLOWED_REPOS` (`owner/repo`, comma-separated).

**Sentry** (Settings → Developer Settings → Internal Integration): webhook URL
`https://<server>/api/webhooks/sentry`, enable the *issue* resource (and alert rule actions if you want
`event_alert`). Put the integration's client secret in `SENTRY_CLIENT_SECRET`; for resolve, a token with
issue write access in `SENTRY_API_TOKEN`, plus `SENTRY_ORG` and `SENTRY_ALLOWED_PROJECTS`.

Invalid signature → `401`; a Sentry timestamp more than 5 minutes off → `401`; body over 1 MB → `413`; a
redelivered webhook → `200 {"status":"duplicate"}` with no new row. Sentry `issue` and `event_alert`/`error`
deliveries for the same issue produce one alert.

## Pairing

1. Glasses without a token call `POST /api/pair/start` and show a 6-character code (valid 10 min); they poll
   `GET /api/pair/status` every 2 s.
2. The operator opens `/pair`, enters `ADMIN_SECRET`, the code and a device name, and approves.
3. The next poll returns the device token **once**; the server stores only its SHA-256 hash.
4. Revoke a device at `/pair` (or `POST /api/admin/devices/revoke`). On the glasses, long-press on Idle →
   confirm to unpair (two steps; the prompt falls back to Idle if left alone).

Pair starts are rate limited per IP (`PAIR_RATE_LIMIT`, default 5 per 10 minutes).

## API (summary)

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/webhooks/github` | HMAC `X-Hub-Signature-256` | ingest, dedup on `X-GitHub-Delivery` |
| `POST /api/webhooks/sentry` | HMAC `Sentry-Hook-Signature` | ingest, dedup on `Request-ID` + issue id |
| `GET /api/alerts?since=<cursor>` | Bearer device token | alert feed (CORS: `GLASSES_ORIGINS`) |
| `POST /api/pair/start`, `GET /api/pair/status` | none / poll secret | device pairing |
| `POST /api/admin/pair/approve`, `POST /api/admin/devices/revoke` | Bearer `ADMIN_SECRET` | operator |
| `POST /api/actions/intent` | paired device | `{alertId, action: "rerun"\|"resolve"}` → preview + one-time nonce |
| `POST /api/actions/confirm` | paired device | execute with the nonce (once, within the TTL) |
| `POST /api/voice?alertId=&sampleRate=` | device token | audio (PCM s16le / WAV / WebM / Ogg / MP3 / M4A, ≤ 256 KB) → `{transcript, intent}`; never executes |
| `POST /api/alerts/{id}/summary[?refresh=1]` | device token | AI / cached / fallback summary |
| `GET /api/audit` | device token (own entries) or `ADMIN_SECRET` | audit log |

Web pages: `/pair` (approve/revoke devices) and `/audit` (audit log), both behind `ADMIN_SECRET`.

## Security & privacy

- **No secrets in the glasses bundle.** The device token is obtained at runtime via pairing and stored on
  the device; only its hash is kept on the server. Revoked tokens are rejected immediately.
- The static `DEVICE_TOKEN` works outside production only and is **read-only**; write actions require a
  paired device.
- **Writes are narrow**: only rerun of a GitHub workflow run and resolve of a Sentry issue, only for
  allowlisted repos/projects, always through Confirm with a one-time nonce (default 60 s). Voice can never
  bypass Confirm. `ACTIONS_DRY_RUN=1` skips the provider calls.
- **Rate limits / quotas**: actions 10 per 10 min per device; voice 20 per 10 min per device; AI summaries
  20 per 10 min per device and 100 per hour globally; pair starts per IP.
- **Audit log** for pairing, actions, voice intents and summaries (`/audit`).
- Webhooks: HMAC verification with constant-time compare, replay dedup, 1 MB body limit.
- **Third-party data processing**:
  - **Anthropic**: when an AI summary is requested, selected alert fields (source, kind, severity, status,
    scope such as repo/project, title and a truncated description) are sent to the Anthropic API. The raw
    webhook payload is never sent. Alert text is treated as untrusted input in the prompt; output is
    stripped of URLs/markdown and capped at 240 chars. Leave `ANTHROPIC_API_KEY` unset to disable this
    (heuristic summary only).
  - **Cartesia**: voice recordings (≤ ~6 s) are sent to Cartesia for transcription. The transcript (first
    120 chars) is stored in the audit log; audio is not stored by Pagerline. Leave `CARTESIA_API_KEY` unset
    to disable voice (`503`).
  - **GitHub / Sentry**: called only for confirmed actions.

## Limitations

- **No hardware testing.** The developer does not own G2 glasses; everything was tested in the Even Hub
  simulator. Ring/touchpad input on real hardware and the real G2 microphone are untested. The simulator
  does deliver microphone audio (16 kHz s16le PCM), which is what the voice path was tested with.
- The browser-microphone fallback (`getUserMedia` + `MediaRecorder`) is **not tested** yet.
- Speech-to-text is English only; the intent parser is rule-based and deliberately strict (long or
  ambiguous sentences → "unknown").
- Polling (3 s) instead of push; single operator (one `ADMIN_SECRET`), no multi-tenant support.
- Only GitHub Actions and Sentry are supported as sources; only two write actions.

## Built during the hackathon

All code in this repository was written during the hackathon, starting 24 Nov 2026 (after the 23 Nov
start date). No code was written before the hackathon or copied from earlier projects; the app structure
follows the public [evenhub-templates](https://github.com/even-realities/evenhub-templates) layout,
rewritten from scratch.

## Third-party libraries and services

Exact versions are pinned in the `package.json` files.

| Library / service | Version | Used in | Use |
| --- | --- | --- | --- |
| [@evenrealities/even_hub_sdk](https://www.npmjs.com/package/@evenrealities/even_hub_sdk) | 0.0.16 | glasses | G2 display/input/mic bridge |
| [@evenrealities/evenhub-cli](https://www.npmjs.com/package/@evenrealities/evenhub-cli) | 0.2.0 | glasses (dev) | `.ehpk` packaging |
| [@evenrealities/evenhub-simulator](https://www.npmjs.com/package/@evenrealities/evenhub-simulator) | 0.9.5 (global) | dev tool | glasses simulator |
| [Vite](https://vitejs.dev) | 6.4.6 | glasses (dev) | dev server + bundler |
| [TypeScript](https://www.typescriptlang.org) | 5.9.3 | all (dev) | type checking |
| [Next.js](https://nextjs.org) | 16.4.6 | server | route handlers + pages |
| [React / React DOM](https://react.dev) | 19.3.1 | server | `/pair`, `/audit` pages |
| [Drizzle ORM](https://orm.drizzle.team) / drizzle-kit | 0.45.4 / 0.31.11 | server | schema, queries, migrations |
| [postgres](https://github.com/porsager/postgres) (postgres.js) | 3.4.9 | server | Postgres driver |
| @types/node, @types/react | 24.19.2, 19.3.0 | server (dev) | type definitions |
| [PostgreSQL](https://www.postgresql.org) / [Neon](https://neon.tech) | 16+ | infra | database |
| [Vercel](https://vercel.com) | — | infra | hosting |
| [Cartesia](https://cartesia.ai) STT (`ink-whisper`) | API | server | speech-to-text |
| [Anthropic](https://www.anthropic.com) (`claude-haiku-5-5`) | API | server | alert summaries |

## License

[MIT](LICENSE)
