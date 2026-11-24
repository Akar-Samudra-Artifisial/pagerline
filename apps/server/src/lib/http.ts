// CORS + JSON helpers for routes the glasses WebView calls directly.

function allowedOrigins(): string[] {
  return (process.env.GLASSES_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  const headers: Record<string, string> = { Vary: 'Origin' }
  if (origin && allowedOrigins().includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
    headers['Access-Control-Max-Age'] = '600'
  }
  return headers
}

export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export const MAX_WEBHOOK_BYTES = 1024 * 1024

/**
 * Read the raw body as text, refusing more than `maxBytes`. Rejects early on a
 * declared Content-Length and also counts streamed bytes (chunked bodies).
 * Returns null when the limit is exceeded.
 */
export async function readBodyLimited(request: Request, maxBytes = MAX_WEBHOOK_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const MAX_JSON_BYTES = 16 * 1024

/** Small JSON object body for API calls from the glasses/scripts; null when missing, too big, or not an object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readBodyLimited(request, MAX_JSON_BYTES)
  if (body === null || body === '') return body === '' ? {} : null
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** 500 for a missing server secret: the env name goes to the server log, never the response. */
export function notConfigured(envName: string): Response {
  console.error(`[pagerline] ${envName} is not configured`)
  return json({ error: 'server not configured' }, 500)
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: extra })
}
