import { and, count, eq, gt, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { audit } from './audit'

/** Advisory lock namespace (two-int form) for quotas counted from `audit_log`. */
const QUOTA_LOCK = 0x504c_04

export interface QuotaLimit {
  limit: number
  windowMs: number
}

export type QuotaResult = 'ok' | 'device' | 'global'

/**
 * Reserve one use of a per-device quota (and optionally a global one across all devices):
 * under advisory locks, count `event` rows in the window and, if below every limit, append one
 * (so parallel calls cannot overshoot). The global lock is always taken first (fixed order, no
 * deadlock). Returns which limit was exhausted, or 'ok'.
 */
export async function reserveQuotaChecked(
  deviceId: string,
  event: string,
  device: QuotaLimit,
  global: QuotaLimit | null,
  detail: Record<string, unknown> = {},
  alertId: string | null = null,
): Promise<QuotaResult> {
  const actor = `device:${deviceId}`
  const t = schema.auditLog
  return getDb().transaction(async (tx) => {
    if (global) {
      await tx.execute(sql`select pg_advisory_xact_lock(${QUOTA_LOCK}::int, hashtext(${`${event}:*`}))`)
      const [{ n }] = await tx
        .select({ n: count() })
        .from(t)
        .where(and(eq(t.event, event), gt(t.createdAt, new Date(Date.now() - global.windowMs))))
      if (n >= global.limit) return 'global'
    }
    await tx.execute(sql`select pg_advisory_xact_lock(${QUOTA_LOCK}::int, hashtext(${`${event}:${deviceId}`}))`)
    const [{ n }] = await tx
      .select({ n: count() })
      .from(t)
      .where(and(eq(t.event, event), eq(t.actor, actor), gt(t.createdAt, new Date(Date.now() - device.windowMs))))
    if (n >= device.limit) return 'device'
    await audit({ event, actor, alertId, detail }, tx)
    return 'ok'
  })
}

/** Per-device quota only; false when exhausted. */
export async function reserveQuota(
  deviceId: string,
  event: string,
  limit: number,
  windowMs: number,
  detail: Record<string, unknown> = {},
  alertId: string | null = null,
): Promise<boolean> {
  return (await reserveQuotaChecked(deviceId, event, { limit, windowMs }, null, detail, alertId)) === 'ok'
}
