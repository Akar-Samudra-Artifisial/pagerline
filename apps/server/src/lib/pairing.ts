import type { PairStartResponse, PairStatusResponse } from '@pagerline/shared'
import { and, count, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { audit } from './audit'
import { hashIp } from './auth'
import { randomCode, randomSecret, sha256Hex } from './crypto'

export const PAIR_TTL_MS = 10 * 60_000
export const PAIR_POLL_INTERVAL_MS = 2_000
const PAIR_RATE_WINDOW_MS = 10 * 60_000
const CODE_PATTERN = /^[A-HJKMNP-Z2-9]{6}$/

/** Pair starts allowed per IP per 10 minutes (`PAIR_RATE_LIMIT`, default 5). */
function pairRateLimit(): number {
  const n = Number(process.env.PAIR_RATE_LIMIT ?? '5')
  return Number.isSafeInteger(n) && n > 0 ? n : 5
}

export type PairStartResult = { ok: true; body: PairStartResponse } | { ok: false; status: 429; error: string }

/** Advisory lock namespace (two-int form) for the per-IP pair-start count + insert. */
const PAIR_RATE_LOCK = 0x504c_04

export async function startPairing(ip: string): Promise<PairStartResult> {
  const p = schema.pairingCodes
  const ipHash = hashIp(ip)

  return getDb().transaction(async (tx): Promise<PairStartResult> => {
    // Count + insert under a per-IP lock so parallel starts cannot exceed the limit.
    await tx.execute(sql`select pg_advisory_xact_lock(${PAIR_RATE_LOCK}::int, hashtext(${ipHash}))`)
    const [{ n }] = await tx
      .select({ n: count() })
      .from(p)
      .where(and(eq(p.requesterIpHash, ipHash), gt(p.createdAt, new Date(Date.now() - PAIR_RATE_WINDOW_MS))))
    if (n >= pairRateLimit()) {
      await audit({ event: 'pair.rate_limited', actor: 'anonymous', detail: { ipHash } }, tx)
      return { ok: false, status: 429, error: 'too many pairing attempts, try again later' }
    }

    const pollSecret = randomSecret()
    const expiresAt = new Date(Date.now() + PAIR_TTL_MS)
    // 31^6 ≈ 8.9e8 codes; retry the rare primary-key collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode()
      const rows = await tx
        .insert(p)
        .values({ code, expiresAt, pollSecretHash: sha256Hex(pollSecret), requesterIpHash: ipHash })
        .onConflictDoNothing()
        .returning({ code: p.code })
      if (rows.length === 1) {
        await audit({ event: 'pair.start', actor: 'anonymous', detail: { ipHash, expiresAt: expiresAt.toISOString() } }, tx)
        return {
          ok: true,
          body: { code, pollSecret, expiresAt: expiresAt.toISOString(), pollIntervalMs: PAIR_POLL_INTERVAL_MS },
        }
      }
    }
    throw new Error('could not allocate a unique pairing code after 5 attempts')
  })
}

/**
 * Device poll. After admin approval the device token is minted, stored only as a
 * hash, and returned exactly once (`used_at` flips atomically); later polls see `claimed`.
 */
export async function pairingStatus(pollSecret: string): Promise<PairStatusResponse | null> {
  const db = getDb()
  const p = schema.pairingCodes
  const d = schema.devices
  const secretHash = sha256Hex(pollSecret)

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(p)
      .where(eq(p.pollSecretHash, secretHash))
      .for('update')
      .limit(1)
    if (!row) return null
    if (row.usedAt !== null) return { status: 'claimed' }
    if (row.expiresAt.getTime() <= Date.now()) return { status: 'expired' }
    if (row.approvedAt === null || row.deviceId === null) {
      return { status: 'pending', expiresAt: row.expiresAt.toISOString() }
    }

    const token = randomSecret()
    const [device] = await tx
      .update(d)
      .set({ tokenHash: sha256Hex(token) })
      .where(and(eq(d.id, row.deviceId), isNull(d.revokedAt)))
      .returning({ id: d.id, name: d.name })
    if (!device) return { status: 'expired' }
    await tx.update(p).set({ usedAt: new Date() }).where(eq(p.code, row.code))
    await audit({ event: 'pair.claimed', actor: `device:${device.id}`, detail: { deviceId: device.id } }, tx)
    return { status: 'approved', deviceId: device.id, deviceName: device.name, token }
  })
}

export type AdminResult = { ok: true; message: string; deviceId?: string } | { ok: false; message: string }

export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

/** Approve a pending, unexpired code and create its device row (token is minted on claim). */
export async function approvePairing(rawCode: string, rawName: string): Promise<AdminResult> {
  const code = normalizeCode(rawCode)
  if (!CODE_PATTERN.test(code)) return { ok: false, message: 'code must be 6 characters (A–Z, 2–9)' }
  const name = rawName.trim().slice(0, 60) || 'Even G2'

  const db = getDb()
  const p = schema.pairingCodes
  return db.transaction(async (tx): Promise<AdminResult> => {
    // Claim the code first (row lock via UPDATE) so a concurrent approve cannot create a second device.
    const claimed = await tx
      .update(p)
      .set({ approvedAt: new Date() })
      .where(and(eq(p.code, code), isNull(p.approvedAt), isNull(p.usedAt), gt(p.expiresAt, new Date())))
      .returning({ code: p.code })
    if (claimed.length === 0) return { ok: false, message: 'code not found, expired, or already approved' }

    const [device] = await tx
      .insert(schema.devices)
      // Placeholder hash of a discarded random value: unusable until the device claims its token.
      .values({ name, tokenHash: sha256Hex(`unclaimed:${randomSecret()}`) })
      .returning({ id: schema.devices.id })
    await tx.update(p).set({ deviceId: device.id }).where(eq(p.code, code))
    await audit({ event: 'pair.approved', actor: 'admin', detail: { deviceId: device.id, name } }, tx)
    return { ok: true, message: `approved “${name}”; the glasses will pick up the token`, deviceId: device.id }
  })
}

export async function revokeDevice(rawId: string): Promise<AdminResult> {
  const id = rawId.trim()
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, message: 'device id must be a UUID' }
  const d = schema.devices
  const rows = await getDb()
    .update(d)
    .set({ revokedAt: new Date() })
    .where(and(eq(d.id, id), isNull(d.revokedAt)))
    .returning({ id: d.id, name: d.name })
  if (rows.length === 0) return { ok: false, message: 'device not found or already revoked' }
  await audit({ event: 'pair.revoked', actor: 'admin', detail: { deviceId: id, name: rows[0].name } })
  return { ok: true, message: `revoked “${rows[0].name}”`, deviceId: id }
}

export interface DeviceSummary {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
  claimed: boolean
}

export async function listDevices(): Promise<DeviceSummary[]> {
  const d = schema.devices
  const p = schema.pairingCodes
  const rows = await getDb()
    .select({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      revokedAt: d.revokedAt,
      usedAt: p.usedAt,
    })
    .from(d)
    .leftJoin(p, and(eq(p.deviceId, d.id), isNotNull(p.usedAt)))
    .orderBy(d.createdAt)
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    claimed: r.usedAt !== null,
  }))
}
