import type { AuditEntry } from '@pagerline/shared'
import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'

type Executor = Pick<ReturnType<typeof getDb>, 'insert'>

export interface AuditEvent {
  event: string
  /** `device:<id>`, `admin`, `github`, `sentry`, `anonymous`. */
  actor: string
  alertId?: string | null
  detail?: Record<string, unknown>
}

/** Append one audit row (pass a transaction to make it atomic with the change it records). */
export async function audit(e: AuditEvent, db: Executor = getDb()): Promise<void> {
  await db.insert(schema.auditLog).values({
    event: e.event,
    actor: e.actor,
    alertId: e.alertId ?? null,
    detail: e.detail ?? {},
  })
}

export const AUDIT_MAX_LIMIT = 200

/**
 * Newest-first page of the audit log; `before` is an exclusive id cursor.
 * With `deviceId`, only that device's entries (its own actions, or rows naming it in `detail.deviceId`).
 */
export async function listAudit(limit: number, before: number | null, deviceId: string | null = null): Promise<AuditEntry[]> {
  const t = schema.auditLog
  const rows = await getDb()
    .select()
    .from(t)
    .where(
      and(
        before === null ? undefined : lt(t.id, before),
        deviceId === null
          ? undefined
          : or(eq(t.actor, `device:${deviceId}`), sql`${t.detail}->>'deviceId' = ${deviceId}`),
      ),
    )
    .orderBy(desc(t.id))
    .limit(Math.min(Math.max(limit, 1), AUDIT_MAX_LIMIT))
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    actor: r.actor,
    alertId: r.alertId,
    detail: (r.detail ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  }))
}
