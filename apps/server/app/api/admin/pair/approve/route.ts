import { adminDenied, verifyAdminRequest } from '@/lib/auth'
import { json, readJsonObject } from '@/lib/http'
import { approvePairing } from '@/lib/pairing'

/** Scripted twin of the /pair Server Action: `Authorization: Bearer <ADMIN_SECRET>`, body `{code, name?}`. */
export async function POST(request: Request) {
  const noStore = { 'Cache-Control': 'no-store' }
  const check = await verifyAdminRequest(request, 'api.admin.pair.approve')
  if (check !== 'ok') {
    const { status, error } = adminDenied(check)
    return json({ error }, status, noStore)
  }
  const body = await readJsonObject(request)
  if (!body || typeof body.code !== 'string') return json({ error: 'body must be {code, name?}' }, 400, noStore)
  const result = await approvePairing(body.code, typeof body.name === 'string' ? body.name : '')
  return json(result, result.ok ? 200 : 404, noStore)
}
