import { createHmac, timingSafeEqual } from 'node:crypto'

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

/** GitHub: `X-Hub-Signature-256: sha256=<hex>` over the raw body. */
export function verifyGithubSignature(secret: string, body: string, header: string | null): boolean {
  if (!header) return false
  return safeEqual(`sha256=${hmacSha256Hex(secret, body)}`, header)
}

/** Sentry integration platform: `Sentry-Hook-Signature: <hex>` over the raw body. */
export function verifySentrySignature(secret: string, body: string, header: string | null): boolean {
  if (!header) return false
  return safeEqual(hmacSha256Hex(secret, body), header)
}
