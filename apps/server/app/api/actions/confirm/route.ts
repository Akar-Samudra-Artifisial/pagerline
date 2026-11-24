import { confirmIntent } from '@/lib/actions'
import { authenticateDevice } from '@/lib/auth'
import { corsHeaders, isUuid, json, preflight, readJsonObject } from '@/lib/http'

export function OPTIONS(request: Request) {
  return preflight(request)
}

/**
 * Body `{requestId, nonce}` → 200 ActionConfirmResult (provider failures are `status: "failed"`).
 * 409 already confirmed, 410 expired, 403 bad nonce / unpaired, 404 unknown request.
 */
export async function POST(request: Request) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const device = await authenticateDevice(request)
  if (!device) return json({ error: 'unauthorized' }, 401, cors)
  if (device.kind !== 'paired') return json({ error: 'write actions require a paired device' }, 403, cors)

  const body = await readJsonObject(request)
  if (!body || !isUuid(body.requestId) || typeof body.nonce !== 'string' || body.nonce.length > 200) {
    return json({ error: 'body must be {requestId: uuid, nonce: string}' }, 400, cors)
  }
  const result = await confirmIntent(device.deviceId, body.requestId, body.nonce)
  if (!result.ok) return json({ error: result.error }, result.status, cors)
  return json(result.result, 200, cors)
}
