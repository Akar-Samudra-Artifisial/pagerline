import type { AlertSeverity, AlertSource, AlertStatus, AlertTarget } from '@pagerline/shared'
import { and, eq, ne, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

export interface NormalizedAlert {
  kind: string
  severity: AlertSeverity
  title: string
  summary: string
  scope: string | null
  url: string | null
  /** Provider object identity shared by related webhooks (e.g. one Sentry issue); null = dedup by delivery only. */
  dedupKey: string | null
  /** Provider object write actions operate on; null when none. */
  target: AlertTarget | null
  /**
   * Status the provider reports for the object (e.g. Sentry `issue.resolved` / `issue.unresolved`).
   * When set and an alert with the same dedup key exists, its status is updated (and its `seq` bumped).
   */
  status?: AlertStatus
  /** Only update an existing alert; never create one (e.g. `issue.resolved` for an issue we never alerted on). */
  updateOnly?: boolean
}

export type IngestResult =
  | { status: 'created'; id: string; seq: number }
  | { status: 'updated'; id: string; seq: number; alertStatus: AlertStatus }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string }

/** Arbitrary app-wide key for `pg_advisory_xact_lock` around every `seq` allocation. */
const ALERT_SEQ_LOCK = 0x5047_4c01

/**
 * Serialize `seq` allocation: `seq` is drawn and committed while holding the lock, so rows
 * become visible in `seq` order and a reader paging with `?since=` never skips a lower seq
 * that commits later. Every insert AND every status change takes this lock.
 */
async function lockSeq(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ALERT_SEQ_LOCK})`)
}

const nextSeq = sql`nextval(pg_get_serial_sequence('alerts', 'seq'))`

/**
 * Change an alert's status and move it to a fresh `seq`, so clients polling `?since=` receive
 * it again (they upsert by `id`). No-op (null) when the status is already `status`.
 */
async function setStatusLocked(tx: Tx, alertId: string, status: AlertStatus): Promise<number | null> {
  const a = schema.alerts
  const [row] = await tx
    .update(a)
    .set({ status, seq: nextSeq })
    .where(and(eq(a.id, alertId), ne(a.status, status)))
    .returning({ seq: a.seq })
  return row?.seq ?? null
}

/** Status change from a write action (e.g. resolve). Returns the new seq, or null when unchanged. */
export async function setAlertStatus(alertId: string, status: AlertStatus): Promise<number | null> {
  return getDb().transaction(async (tx) => {
    await lockSeq(tx)
    return setStatusLocked(tx, alertId, status)
  })
}

/**
 * Ingest a verified webhook.
 * - Same source + delivery id (redelivery) → `duplicate`, nothing changes.
 * - Same source + dedup key (same provider object): `updated` when the webhook carries a
 *   different status (alert re-sequenced), otherwise `duplicate`.
 * - Otherwise a new alert (`created`), unless `updateOnly` (`ignored`).
 */
export async function ingestAlert(
  source: AlertSource,
  deliveryId: string,
  alert: NormalizedAlert,
  payload: unknown,
): Promise<IngestResult> {
  const { status: reportedStatus, updateOnly, ...fields } = alert
  const a = schema.alerts

  return getDb().transaction(async (tx): Promise<IngestResult> => {
    await lockSeq(tx)

    let result: IngestResult
    let alertId: string | null = null
    const [redelivered] = await tx
      .select({ id: a.id })
      .from(a)
      .where(and(eq(a.source, source), eq(a.deliveryId, deliveryId)))
      .limit(1)
    const [existing] =
      redelivered || alert.dedupKey === null
        ? []
        : await tx
            .select({ id: a.id, status: a.status })
            .from(a)
            .where(and(eq(a.source, source), eq(a.dedupKey, alert.dedupKey)))
            .limit(1)

    if (redelivered) {
      alertId = redelivered.id
      result = { status: 'duplicate' }
    } else if (existing) {
      alertId = existing.id
      const seq = reportedStatus ? await setStatusLocked(tx, existing.id, reportedStatus) : null
      result =
        seq !== null && reportedStatus
          ? { status: 'updated', id: existing.id, seq, alertStatus: reportedStatus }
          : { status: 'duplicate' }
    } else if (updateOnly) {
      result = { status: 'ignored', reason: `${alert.kind} for an object without an alert` }
    } else {
      const rows = await tx
        .insert(a)
        .values({ source, deliveryId, ...fields, status: reportedStatus ?? 'open', payload })
        .onConflictDoNothing()
        .returning({ id: a.id, seq: a.seq })
      const row = rows[0]
      alertId = row?.id ?? null
      result = row ? { status: 'created', id: row.id, seq: row.seq } : { status: 'duplicate' }
    }

    await tx.insert(schema.auditLog).values({
      event: result.status === 'ignored' ? `webhook.${source}.ignored` : `webhook.${source}`,
      actor: source,
      alertId,
      detail: {
        deliveryId,
        dedupKey: alert.dedupKey,
        kind: alert.kind,
        outcome: result.status,
        duplicate: result.status === 'duplicate',
        ...(result.status === 'updated' ? { alertStatus: result.alertStatus } : {}),
      },
    })
    return result
  })
}

/** HTTP status for a webhook ingest result. */
export function ingestHttpStatus(result: IngestResult): number {
  if (result.status === 'created') return 201
  if (result.status === 'ignored') return 202
  return 200
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
