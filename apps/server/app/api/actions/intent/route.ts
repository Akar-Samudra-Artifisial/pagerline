import { isActionKind } from '@pagerline/shared'
import { createIntent } from '@/lib/actions'
import { authenticateDevice } from '@/lib/auth'
import { corsHeaders, isUuid, json, preflight, readJsonObject } from '@/lib/http'

export function OPTIONS(request: Request) {
  return preflight(request)
}

/** Body `{alertId, action}` → 201 ActionPreview with a one-time nonce (paired devices only). */
export async function POST(request: Request) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const device = await authenticateDevice(request)
  if (!device) return json({ error: 'unauthorized' }, 401, cors)
  if (device.kind !== 'paired') return json({ error: 'write actions require a paired device' }, 403, cors)

  const body = await readJsonObject(request)
  if (!body || !isUuid(body.alertId) || !isActionKind(body.action)) {
    return json({ error: 'body must be {alertId: uuid, action: "rerun" | "resolve"}' }, 400, cors)
  }
  const result = await createIntent(device.deviceId, body.alertId, body.action)
  if (!result.ok) return json({ error: result.error }, result.status, cors)
  return json(result.preview, 201, cors)
}
