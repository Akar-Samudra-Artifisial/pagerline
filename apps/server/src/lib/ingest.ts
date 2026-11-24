import type { AlertSeverity, AlertSource } from '@pagerline/shared'
import { sql } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'

export interface NormalizedAlert {
  kind: string
  severity: AlertSeverity
  title: string
  summary: string
  scope: string | null
  url: string | null
  /** Provider object identity shared by related webhooks (e.g. one Sentry issue); null = dedup by delivery only. */
  dedupKey: string | null
}

export type IngestResult = { status: 'created'; id: string; seq: number } | { status: 'duplicate' }

/** Arbitrary app-wide key for `pg_advisory_xact_lock` around alert inserts. */
const ALERT_INSERT_LOCK = 0x5047_4c01

/**
 * Insert an alert. A redelivered webhook (same source + delivery id) or another
 * webhook about the same provider object (same source + dedup key) hits a unique
 * index and is reported as a duplicate instead of creating a second row.
 *
 * Inserts are serialized with a transaction-scoped advisory lock: `seq` is drawn
 * and committed while holding the lock, so rows become visible in `seq` order and
 * a reader paging with `?since=` can never skip a lower seq that commits later.
 */
export async function ingestAlert(
  source: AlertSource,
  deliveryId: string,
  alert: NormalizedAlert,
  payload: unknown,
): Promise<IngestResult> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ALERT_INSERT_LOCK})`)
    const rows = await tx
      .insert(schema.alerts)
      .values({ source, deliveryId, ...alert, payload })
      .onConflictDoNothing()
      .returning({ id: schema.alerts.id, seq: schema.alerts.seq })

    const row = rows[0]
    await tx.insert(schema.auditLog).values({
      event: `webhook.${source}`,
      actor: source,
      alertId: row?.id ?? null,
      detail: { deliveryId, dedupKey: alert.dedupKey, kind: alert.kind, duplicate: !row },
    })
    return row ? { status: 'created', id: row.id, seq: row.seq } : { status: 'duplicate' }
  })
}

/** Audit a verified webhook that produced no alert (ping, success, unsupported event). */
export async function auditIgnored(source: AlertSource, deliveryId: string, reason: string): Promise<void> {
  await getDb()
    .insert(schema.auditLog)
    .values({ event: `webhook.${source}.ignored`, actor: source, detail: { deliveryId, reason } })
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}
