import { clientIp } from '@/lib/auth'
import { corsHeaders, json, preflight } from '@/lib/http'
import { startPairing } from '@/lib/pairing'

export function OPTIONS(request: Request) {
  return preflight(request)
}

/** Glasses ask for a pairing code (no auth; rate limited per IP). */
export async function POST(request: Request) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const ip = clientIp(request.headers)
  if (ip === null) return json({ error: 'client address unavailable' }, 400, cors)
  const result = await startPairing(ip)
  if (!result.ok) return json({ error: result.error }, result.status, cors)
  return json(result.body, 201, cors)
}
