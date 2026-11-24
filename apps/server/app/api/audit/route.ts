import type { AuditResponse } from '@pagerline/shared'
import { listAudit } from '@/lib/audit'
import { adminDenied, authenticateDevice, verifyAdminRequest } from '@/lib/auth'
import { corsHeaders, json, preflight } from '@/lib/http'

export function OPTIONS(request: Request) {
  return preflight(request)
}

/**
 * `?limit=1..200&before=<id>`, newest first.
 * Bearer device token → only that device's own entries; Bearer ADMIN_SECRET → everything.
 */
export async function GET(request: Request) {
  // CORS only for a valid device token: admin-secret and failed-auth responses must not be readable
  // cross-origin (GLASSES_ORIGINS may be `*`).
  let cors: Record<string, string> = { 'Cache-Control': 'no-store' }
  let deviceId: string | null = null
  const device = await authenticateDevice(request)
  if (device) {
    deviceId = device.deviceId
    cors = { ...corsHeaders(request), ...cors }
  } else {
    const check = await verifyAdminRequest(request, 'api.audit')
    if (check !== 'ok') {
      const { status, error } = adminDenied(check)
      return json({ error }, status, cors)
    }
  }

  const params = new URL(request.url).searchParams
  const limit = Number(params.get('limit') ?? '50')
  const beforeRaw = params.get('before')
  const before = beforeRaw === null || beforeRaw === '' ? null : Number(beforeRaw)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return json({ error: '`limit` must be an integer 1..200' }, 400, cors)
  }
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
    return json({ error: '`before` must be a positive integer id' }, 400, cors)
  }

  const entries = await listAudit(limit, before, deviceId)
  const body: AuditResponse = {
    entries,
    nextBefore: entries.length === limit ? (entries.at(-1)?.id ?? null) : null,
  }
  return json(body, 200, cors)
}
