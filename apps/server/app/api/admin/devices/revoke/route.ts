import { adminDenied, verifyAdminRequest } from '@/lib/auth'
import { json, readJsonObject } from '@/lib/http'
import { revokeDevice } from '@/lib/pairing'

/** Scripted twin of the /pair revoke Server Action: `Authorization: Bearer <ADMIN_SECRET>`, body `{deviceId}`. */
export async function POST(request: Request) {
  const noStore = { 'Cache-Control': 'no-store' }
  const check = await verifyAdminRequest(request, 'api.admin.devices.revoke')
  if (check !== 'ok') {
    const { status, error } = adminDenied(check)
    return json({ error }, status, noStore)
  }
  const body = await readJsonObject(request)
  if (!body || typeof body.deviceId !== 'string') return json({ error: 'body must be {deviceId}' }, 400, noStore)
  const result = await revokeDevice(body.deviceId)
  return json(result, result.ok ? 200 : 404, noStore)
}
