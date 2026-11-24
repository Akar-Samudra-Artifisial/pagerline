import type { SummaryResponse, SummarySource } from '@pagerline/shared'
import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { audit } from '@/lib/audit'
import { authenticateDevice } from '@/lib/auth'
import { corsHeaders, isUuid, json, preflight } from '@/lib/http'
import { reserveQuotaChecked } from '@/lib/quota'
import { aiConfigured, fallbackSummary, generateSummary, mockAiRequested, SUMMARY_MODEL } from '@/lib/summary'

export const maxDuration = 30

/** AI generations (first time or `?refresh=1`) per device per 10 minutes. */
const SUMMARY_LIMIT = 20
const SUMMARY_WINDOW_MS = 10 * 60_000
/** AI generations across all devices per hour (the cache is global, so is the LLM spend). */
const SUMMARY_GLOBAL_LIMIT = 100
const SUMMARY_GLOBAL_WINDOW_MS = 60 * 60_000
/** `?refresh=1` on a summary younger than this returns the cached one. */
const REFRESH_COOLDOWN_MS = 60_000

export function OPTIONS(request: Request) {
  return preflight(request)
}

/** → 200 SummaryResponse: cached AI summary, a fresh one, or a heuristic fallback. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const device = await authenticateDevice(request)
  if (!device) return json({ error: 'unauthorized' }, 401, cors)

  const { id } = await ctx.params
  if (!isUuid(id)) return json({ error: 'alert id must be a uuid' }, 400, cors)
  const refresh = new URL(request.url).searchParams.get('refresh') === '1'

  const db = getDb()
  const a = schema.alerts
  const [alert] = await db
    .select({
      id: a.id,
      source: a.source,
      kind: a.kind,
      severity: a.severity,
      status: a.status,
      title: a.title,
      summary: a.summary,
      scope: a.scope,
      aiSummary: a.aiSummary,
      aiSummaryAt: a.aiSummaryAt,
    })
    .from(a)
    .where(eq(a.id, id))
    .limit(1)
  if (!alert) return json({ error: 'alert not found' }, 404, cors)

  const actor = `device:${device.deviceId}`
  const cached: SummaryResponse | null =
    alert.aiSummary && alert.aiSummaryAt
      ? { alertId: id, summary: alert.aiSummary, source: 'cache', generatedAt: alert.aiSummaryAt.toISOString() }
      : null
  const respond = async (body: SummaryResponse, reason?: string) => {
    await audit({ event: 'alert.summary', actor, alertId: id, detail: { source: body.source, refresh, ...(reason ? { reason } : {}) } })
    return json(body, 200, cors)
  }
  const fallback = (reason: string) =>
    respond(cached ?? { alertId: id, summary: fallbackSummary(alert), source: 'fallback', generatedAt: null }, reason)

  if (cached && !refresh) return respond(cached)
  if (cached && alert.aiSummaryAt && Date.now() - alert.aiSummaryAt.getTime() < REFRESH_COOLDOWN_MS) {
    return respond(cached, 'refresh cooldown')
  }

  const mock = mockAiRequested(request)
  if (!mock && !aiConfigured()) return fallback('ai not configured')

  const quota = await reserveQuotaChecked(
    device.deviceId,
    'summary.request',
    { limit: SUMMARY_LIMIT, windowMs: SUMMARY_WINDOW_MS },
    { limit: SUMMARY_GLOBAL_LIMIT, windowMs: SUMMARY_GLOBAL_WINDOW_MS },
    { refresh },
    id,
  )
  if (quota !== 'ok') {
    if (refresh) {
      const error =
        quota === 'device'
          ? `rate limit: ${SUMMARY_LIMIT} AI summaries per 10 minutes per device`
          : `rate limit: ${SUMMARY_GLOBAL_LIMIT} AI summaries per hour on this server`
      return json({ error }, 429, cors)
    }
    return fallback(`rate limited (${quota})`)
  }

  const result = mock ? { ok: true as const, text: `Mock summary: ${alert.severity} ${alert.source} alert.` } : await generateSummary(alert)
  if (!result.ok) {
    console.error(`[pagerline] summary ${id} failed: ${result.message}`)
    return fallback(result.message.slice(0, 80))
  }

  const now = new Date()
  // Only cache if the status is unchanged since we read it (a status change clears the cache).
  await db
    .update(a)
    .set({ aiSummary: result.text, aiSummaryAt: now })
    .where(and(eq(a.id, id), eq(a.status, alert.status)))
  const source: SummarySource = 'ai'
  return respond(
    { alertId: id, summary: result.text, source, generatedAt: now.toISOString() },
    mock ? 'mock' : `model ${SUMMARY_MODEL}`,
  )
}
