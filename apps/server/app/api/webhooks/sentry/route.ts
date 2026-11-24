import { verifySentrySignature } from '@/lib/crypto'
import { json, notConfigured, readBodyLimited } from '@/lib/http'
import { auditIgnored, ingestAlert } from '@/lib/ingest'
import { parseJson } from '@/lib/payload'
import { normalizeSentry } from '@/lib/sentry'

/** Maximum allowed clock difference for `Sentry-Hook-Timestamp`. */
const MAX_SKEW_SECONDS = 5 * 60

/** null when the header is absent or within the window; otherwise the rejection reason. */
function staleTimestamp(header: string | null, nowMs = Date.now()): string | null {
  if (header === null) return null
  const ts = Number(header)
  if (!Number.isFinite(ts)) return 'invalid Sentry-Hook-Timestamp'
  // Sentry sends Unix seconds; tolerate milliseconds just in case.
  const seconds = ts > 1e12 ? ts / 1000 : ts
  return Math.abs(nowMs / 1000 - seconds) > MAX_SKEW_SECONDS ? 'stale Sentry-Hook-Timestamp' : null
}

export async function POST(request: Request) {
  const secret = process.env.SENTRY_CLIENT_SECRET
  if (!secret) return notConfigured('SENTRY_CLIENT_SECRET')

  const body = await readBodyLimited(request)
  if (body === null) return json({ error: 'payload too large' }, 413)
  if (!verifySentrySignature(secret, body, request.headers.get('sentry-hook-signature'))) {
    return json({ error: 'invalid signature' }, 401)
  }

  // The signature covers only the body, so the timestamp is a replay heuristic, checked when present.
  const stale = staleTimestamp(request.headers.get('sentry-hook-timestamp'))
  if (stale) return json({ error: stale }, 401)

  const resource = request.headers.get('sentry-hook-resource')
  const deliveryId = request.headers.get('request-id')
  if (!resource || !deliveryId) return json({ error: 'missing Sentry-Hook-Resource or Request-ID' }, 400)

  const payload = parseJson(body)
  if (!payload) return json({ error: 'body is not a JSON object' }, 400)

  const normalized = normalizeSentry(resource, payload)
  if (typeof normalized === 'string') {
    await auditIgnored('sentry', deliveryId, normalized)
    return json({ status: 'ignored', reason: normalized }, 202)
  }

  const result = await ingestAlert('sentry', deliveryId, normalized, payload)
  return json(result, result.status === 'created' ? 201 : 200)
}
