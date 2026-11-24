import { and, count, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { audit } from './audit'
import { hmacSha256Hex, safeEqual, safeEqualHashed, sha256Hex } from './crypto'

export interface DeviceAuth {
  deviceId: string
  /**
   * `paired` = per-device token issued through pairing (read + write).
   * `static` = shared `DEVICE_TOKEN`, outside production only, read-only.
   */
  kind: 'paired' | 'static'
}

/** Device id reported for the shared dev token (never a row in `devices`). */
export const STATIC_DEVICE_ID = 'static-dev-token'

/** Update `last_seen_at` at most once per minute per device. */
const LAST_SEEN_RESOLUTION_MS = 60_000

export function isProduction(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}

export function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')
  const token = match?.[1].trim()
  return token ? token : null
}

/**
 * Authenticate the glasses: a paired device token (SHA-256 looked up in `devices`,
 * rejected once revoked), or — outside production only — the static `DEVICE_TOKEN`.
 */
export async function authenticateDevice(request: Request): Promise<DeviceAuth | null> {
  const token = bearerToken(request)
  if (!token) return null

  const staticToken = process.env.DEVICE_TOKEN
  if (staticToken && !isProduction() && safeEqual(token, staticToken)) {
    return { deviceId: STATIC_DEVICE_ID, kind: 'static' }
  }

  const db = getDb()
  const d = schema.devices
  const [device] = await db
    .select({ id: d.id, revokedAt: d.revokedAt })
    .from(d)
    .where(eq(d.tokenHash, sha256Hex(token)))
    .limit(1)
  if (!device || device.revokedAt !== null) return null

  await db
    .update(d)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(d.id, device.id),
        or(isNull(d.lastSeenAt), lt(d.lastSeenAt, new Date(Date.now() - LAST_SEEN_RESOLUTION_MS))),
      ),
    )
  return { deviceId: device.id, kind: 'paired' }
}

// ---------------------------------------------------------------------------
// Client IP

/**
 * Client IP: `x-vercel-forwarded-for` (set by Vercel's edge). Outside production the
 * spoofable `x-forwarded-for` / `x-real-ip` are accepted too (local dev, selftest).
 * Null in production when the platform header is missing — callers must reject.
 */
export function clientIp(headers: Pick<Headers, 'get'>): string | null {
  const first = (name: string) => headers.get(name)?.split(',')[0]?.trim() || null
  const vercel = first('x-vercel-forwarded-for')
  if (vercel) return vercel
  if (isProduction()) return null
  return first('x-forwarded-for') ?? first('x-real-ip') ?? 'local'
}

const MIN_ADMIN_SECRET_LENGTH = 32

/** HMAC key for IP hashes, derived from ADMIN_SECRET (a fixed dev key outside production). */
function ipHashKey(): string {
  const admin = process.env.ADMIN_SECRET
  if (admin && admin.length >= MIN_ADMIN_SECRET_LENGTH) return sha256Hex(`pagerline:ip-hash:v1:${admin}`)
  if (!isProduction()) return 'pagerline-dev-ip-hash-key'
  throw new Error('ADMIN_SECRET (>= 32 chars) must be set to hash client IPs')
}

/** Keyed hash of a client IP (raw IPs are never stored). */
export function hashIp(ip: string): string {
  return hmacSha256Hex(ipHashKey(), ip)
}

// ---------------------------------------------------------------------------
// Admin secret

/** Failed ADMIN_SECRET attempts allowed per 10 minutes, per IP and server-wide. */
const ADMIN_FAIL_WINDOW_MS = 10 * 60_000
const ADMIN_FAIL_LIMIT_PER_IP = 5
const ADMIN_FAIL_LIMIT_GLOBAL = 50
/** Advisory lock key (two-int form namespace) serializing admin failure counting. */
const ADMIN_AUTH_LOCK = 0x504c_03

/**
 * Compare an operator-typed secret to `ADMIN_SECRET` in constant time.
 * False when the env is missing or shorter than 32 characters.
 */
function isAdminSecret(candidate: string | null | undefined): boolean {
  const expected = process.env.ADMIN_SECRET
  if (!expected || expected.length < MIN_ADMIN_SECRET_LENGTH || !candidate) return false
  return safeEqualHashed(candidate, expected)
}

/** `ok`, `denied` (wrong/missing secret), or `limited` (too many recent failures — even a correct secret is refused). */
export type AdminCheck = 'ok' | 'denied' | 'limited'

/**
 * Check an ADMIN_SECRET attempt with a brute-force limit counted from `audit_log`
 * (`admin.auth_failed`): 5 failures per IP and 50 server-wide per 10 minutes.
 * Counting + recording run under one advisory lock so parallel guesses cannot overshoot.
 * An empty candidate is `denied` without being counted.
 */
export async function verifyAdminSecret(
  candidate: string | null | undefined,
  ip: string | null,
  surface: string,
): Promise<AdminCheck> {
  if (!candidate) return 'denied'
  if (ip === null) return 'denied'
  const ipHash = hashIp(ip)
  const t = schema.auditLog
  return getDb().transaction(async (tx): Promise<AdminCheck> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_AUTH_LOCK}::int, 0)`)
    const since = new Date(Date.now() - ADMIN_FAIL_WINDOW_MS)
    const [{ total, fromIp }] = await tx
      .select({
        total: count(),
        fromIp: sql<number>`count(*) filter (where ${t.detail}->>'ipHash' = ${ipHash})`.mapWith(Number),
      })
      .from(t)
      .where(and(eq(t.event, 'admin.auth_failed'), gt(t.createdAt, since)))
    if (fromIp >= ADMIN_FAIL_LIMIT_PER_IP || total >= ADMIN_FAIL_LIMIT_GLOBAL) {
      await audit({ event: 'admin.auth_limited', actor: 'anonymous', detail: { ipHash, surface } }, tx)
      return 'limited'
    }
    if (isAdminSecret(candidate)) return 'ok'
    await audit({ event: 'admin.auth_failed', actor: 'anonymous', detail: { ipHash, surface } }, tx)
    return 'denied'
  })
}

/** `Authorization: Bearer <ADMIN_SECRET>` for scripted admin routes. */
export function verifyAdminRequest(request: Request, surface: string): Promise<AdminCheck> {
  return verifyAdminSecret(bearerToken(request), clientIp(request.headers), surface)
}

/** JSON error for a non-`ok` admin check. */
export function adminDenied(check: Exclude<AdminCheck, 'ok'>): { status: 401 | 429; error: string } {
  return check === 'limited'
    ? { status: 429, error: 'too many failed admin attempts, try again in 10 minutes' }
    : { status: 401, error: 'unauthorized' }
}
