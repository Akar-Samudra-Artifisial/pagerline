import type { AlertTarget } from '@pagerline/shared'
import { sql } from 'drizzle-orm'
import { bigserial, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Monotonic cursor for `GET /api/alerts?since=`. */
    seq: bigserial('seq', { mode: 'number' }).notNull().unique(),
    source: text('source').notNull(),
    /** Provider delivery id (X-GitHub-Delivery / Sentry Request-ID); dedup key. */
    deliveryId: text('delivery_id').notNull(),
    /** Provider object identity (e.g. `issue:<sentry issue id>`) so one incident yields one alert; null = none. */
    dedupKey: text('dedup_key'),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('open'),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    scope: text('scope'),
    url: text('url'),
    payload: jsonb('payload').notNull(),
    /** Structured provider target for actions (`{repo, runId}` / `{org?, project?, issueId}`); null = no action target. */
    target: jsonb('target').$type<AlertTarget>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('alerts_source_delivery_uq').on(t.source, t.deliveryId),
    // NULLs are distinct in Postgres, so alerts without a dedup key never collide here.
    uniqueIndex('alerts_source_dedup_uq').on(t.source, t.dedupKey),
  ],
)

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** SHA-256 hex of the device bearer token; raw token is never stored. */
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const pairingCodes = pgTable(
  'pairing_codes',
  {
    code: text('code').primaryKey(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when the device has claimed its token (token is returned exactly once). */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** SHA-256 hex of the secret the device polls `/api/pair/status` with. */
    pollSecretHash: text('poll_secret_hash'),
    /** Set when an admin approved the code. */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** SHA-256 hex of the requester IP, for the per-IP start rate limit. */
    requesterIpHash: text('requester_ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pairing_codes_poll_secret_uq').on(t.pollSecretHash),
    index('pairing_codes_ip_created_idx').on(t.requesterIpHash, t.createdAt),
  ],
)

export const actionRequests = pgTable(
  'action_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    alertId: uuid('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    /** SHA-256 hex of the one-time confirm nonce; the raw nonce is only sent to the device. */
    nonceHash: text('nonce_hash').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('action_requests_device_created_idx').on(t.deviceId, t.createdAt),
    check(
      'action_requests_status_ck',
      sql`${t.status} in ('pending', 'confirmed', 'expired', 'failed', 'succeeded')`,
    ),
  ],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** e.g. `webhook.github`, `webhook.sentry`, later `action.ack`. */
    event: text('event').notNull(),
    actor: text('actor'),
    alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
)
