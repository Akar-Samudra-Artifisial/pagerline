import { bigserial, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

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

export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

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
