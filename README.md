# Pagerline

Heads-up on-call HUD for **Even Realities G2** glasses: CI failures, new issues and
Sentry alerts land on your glasses as they happen, without reaching for your phone.

Built for the DoraHacks "Heads Up" hackathon (track: AI Assistants & Work).

> **Status: tested in the EvenHub simulator only, no G2 hardware.**

## Layout

```
apps/glasses      Vite + TypeScript plugin using @evenrealities/even_hub_sdk (runs in the Even app WebView)
apps/server       Next.js (App Router route handlers) — webhook ingest + alert feed, Postgres via Drizzle
packages/shared   Shared types: Alert, Intent, ActionTier (Tier 1: ack/assign/comment, Tier 2: rerun/resolve/mute)
scripts/demo-seed Sends signed fake GitHub + Sentry webhooks to the local server
```

## Setup

Requirements: Node 22+, pnpm 11, Postgres 16+, `evenhub-simulator`.

```sh
pnpm install
npm i -g @evenrealities/evenhub-simulator
```

### 1. Postgres

Either with Podman:

```sh
podman run -d --name pagerline-pg -p 5433:5432 \
  -e POSTGRES_USER=pagerline -e POSTGRES_PASSWORD=pagerline -e POSTGRES_DB=pagerline \
  docker.io/library/postgres:16
```

or a throwaway local cluster (Homebrew `postgresql@17`), data kept in `.pgdata/` (gitignored):

```sh
PGB=/opt/homebrew/opt/postgresql@17/bin
$PGB/initdb -D .pgdata -U pagerline --auth=trust
$PGB/pg_ctl -D .pgdata -o "-p 5433 -k /tmp" -l .logs/postgres.log start
$PGB/createdb -h localhost -p 5433 -U pagerline pagerline
```

### 2. Server (port 3300)

```sh
cp apps/server/.env.example apps/server/.env.local   # fill DEVICE_TOKEN + webhook secrets (e.g. `openssl rand -hex 24`)
pnpm db:migrate                                       # applies apps/server/drizzle/*.sql
pnpm dev:server
pnpm seed                                             # signed demo webhooks; `pnpm --filter @pagerline/demo-seed seed --selftest` also checks 401 + dedup
```

Endpoints:

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /api/webhooks/github` | `X-Hub-Signature-256` HMAC | dedup on `X-GitHub-Delivery`; alerts on `workflow_run` (completed + failure) and `issues` (opened/reopened) |
| `POST /api/webhooks/sentry` | `Sentry-Hook-Signature` HMAC | dedup on `Request-ID` and Sentry issue id; resources `issue`, `event_alert`, `error` |
| `GET /api/alerts?since=<cursor>` | `Authorization: Bearer <DEVICE_TOKEN>` | CORS limited to `GLASSES_ORIGINS` |

Invalid signature → `401`; a redelivered webhook → `200 {"status":"duplicate"}` and no new row.

### 3. Glasses app + simulator

```sh
cp apps/glasses/.env.example apps/glasses/.env.local  # VITE_API_BASE; empty → mock data
pnpm dev:glasses                                      # http://localhost:5173
# first run: hand the dev device token to the app at runtime (it is stored, then stripped from the URL)
evenhub-simulator "http://localhost:5173/?token=<DEVICE_TOKEN from apps/server/.env.local>" --automation-port 9898
# later runs: pnpm --filter @pagerline/glasses simulate
```

The device token is never compiled into the bundle: the app reads `?token=` once, keeps it via
`bridge.setLocalStorage` (WebView `localStorage` as fallback) and otherwise runs on mock data.
This static token is a temporary dev credential; per-device pairing replaces it in a later milestone.

Screens (text only, 576×288): **Idle** (status header + 3 latest alerts) → tap → **Inbox** (list, first row
"< Back") → tap a row → **Detail** (header/body/footer). Detail: tap or swipe up = back, swipe down = next alert,
double-tap = action menu (stub). Idle: double-tap = exit. The app polls `GET /api/alerts?since=` every 3 s and
catches up on foreground enter. While the inbox is open, new alerts are counted in the header ("+N new") instead
of rebuilding the list, so the selected row does not jump; they appear when the inbox is re-entered.

Webhook bodies over 1 MB are rejected with `413`; a Sentry webhook whose `Sentry-Hook-Timestamp` is more than
5 minutes off is rejected with `401`. Sentry `issue` and `event_alert`/`error` webhooks for the same Sentry issue
produce a single alert (dedup on the issue id).

Permissions: network only (whitelist `http://localhost:3300` for now). TODO (voice milestone): add
`phone-microphone` and `g2-microphone` when voice intents ship.

## Built during the hackathon

All code in this repository was written during the hackathon, starting 24 Nov 2026 (after the
23 Nov start date). No code was written before the hackathon or copied from earlier projects; the
app structure follows the public evenhub-templates layout, rewritten from scratch.

> Tested in the EvenHub simulator only, no G2 hardware.

## Third-party libraries

Runtime and build dependencies (exact versions pinned in the `package.json` files):

| Library | Version | Used in | Use |
| --- | --- | --- | --- |
| [@evenrealities/even_hub_sdk](https://www.npmjs.com/package/@evenrealities/even_hub_sdk) | 0.0.16 | glasses | G2 display/input bridge |
| [@evenrealities/evenhub-cli](https://www.npmjs.com/package/@evenrealities/evenhub-cli) | 0.2.0 | glasses (dev) | `.ehpk` packaging |
| [@evenrealities/evenhub-simulator](https://www.npmjs.com/package/@evenrealities/evenhub-simulator) | 0.9.5 (global) | dev tool | glasses simulator + automation API |
| [Vite](https://vitejs.dev) | 6.4.6 | glasses (dev) | dev server + bundler |
| [TypeScript](https://www.typescriptlang.org) | 5.9.3 | all (dev) | type checking |
| [Next.js](https://nextjs.org) | 16.4.6 | server | route handlers |
| [React / React DOM](https://react.dev) | 19.3.1 | server | Next.js peer (minimal pages) |
| [Drizzle ORM](https://orm.drizzle.team) | 0.45.4 | server | schema + queries |
| [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) | 0.31.11 | server (dev) | migrations |
| [postgres](https://github.com/porsager/postgres) (postgres.js) | 3.4.9 | server | Postgres driver |
| @types/node, @types/react | 24.19.2, 19.3.0 | server (dev) | type definitions |
| [PostgreSQL](https://www.postgresql.org) | 16+ | infra | database (Podman image or Homebrew) |

App structure follows the official [evenhub-templates](https://github.com/even-realities/evenhub-templates) (minimal / text-heavy).
