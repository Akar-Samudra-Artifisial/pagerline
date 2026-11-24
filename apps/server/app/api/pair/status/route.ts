import { bearerToken } from '@/lib/auth'
import { corsHeaders, json, preflight } from '@/lib/http'
import { pairingStatus } from '@/lib/pairing'

export function OPTIONS(request: Request) {
  return preflight(request)
}

/** Poll with `Authorization: Bearer <pollSecret>`; returns the device token once after approval. */
export async function GET(request: Request) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const pollSecret = bearerToken(request)
  if (!pollSecret) return json({ error: 'missing poll secret' }, 401, cors)
  const status = await pairingStatus(pollSecret)
  if (!status) return json({ error: 'unknown poll secret' }, 401, cors)
  return json(status, 200, cors)
}
