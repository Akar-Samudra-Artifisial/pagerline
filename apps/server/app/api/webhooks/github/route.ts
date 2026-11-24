import { verifyGithubSignature } from '@/lib/crypto'
import { normalizeGithub } from '@/lib/github'
import { json, notConfigured, readBodyLimited } from '@/lib/http'
import { auditIgnored, ingestAlert } from '@/lib/ingest'
import { parseJson } from '@/lib/payload'

export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) return notConfigured('GITHUB_WEBHOOK_SECRET')

  // Verify against the exact raw bytes GitHub signed.
  const body = await readBodyLimited(request)
  if (body === null) return json({ error: 'payload too large' }, 413)
  if (!verifyGithubSignature(secret, body, request.headers.get('x-hub-signature-256'))) {
    return json({ error: 'invalid signature' }, 401)
  }

  const event = request.headers.get('x-github-event')
  const deliveryId = request.headers.get('x-github-delivery')
  if (!event || !deliveryId) return json({ error: 'missing X-GitHub-Event or X-GitHub-Delivery' }, 400)

  const payload = parseJson(body)
  if (!payload) return json({ error: 'body is not a JSON object' }, 400)

  const normalized = normalizeGithub(event, payload)
  if (typeof normalized === 'string') {
    await auditIgnored('github', deliveryId, normalized)
    return json({ status: 'ignored', reason: normalized }, 202)
  }

  const result = await ingestAlert('github', deliveryId, normalized, payload)
  return json(result, result.status === 'created' ? 201 : 200)
}
