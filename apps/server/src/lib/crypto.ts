import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Constant-time compare that also hides the length of the expected value. */
export function safeEqualHashed(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** URL-safe random secret (device tokens, poll secrets, nonces). */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Crockford-ish alphabet without 0/O/1/I/L so codes read cleanly on the glasses. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function randomCode(length = 6): string {
  let code = ''
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
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
