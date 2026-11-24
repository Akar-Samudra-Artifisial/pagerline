import type { Alert, AlertSeverity, AlertSource, AlertStatus, AlertsResponse } from '@pagerline/shared'
import { asc, desc, gt } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { availableActions } from '@/lib/actions'
import { authenticateDevice } from '@/lib/auth'
import { corsHeaders, json, preflight } from '@/lib/http'

const PAGE_LIMIT = 50

export function OPTIONS(request: Request) {
  return preflight(request)
}

export async function GET(request: Request) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  if (!(await authenticateDevice(request))) return json({ error: 'unauthorized' }, 401, cors)

  const sinceRaw = new URL(request.url).searchParams.get('since')
  const since = sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw)
  if (since !== null && (!Number.isSafeInteger(since) || since < 0)) {
    return json({ error: '`since` must be a non-negative integer cursor' }, 400, cors)
  }

  const db = getDb()
  const a = schema.alerts
  const columns = {
    id: a.id,
    seq: a.seq,
    source: a.source,
    kind: a.kind,
    severity: a.severity,
    status: a.status,
    title: a.title,
    summary: a.summary,
    scope: a.scope,
    url: a.url,
    target: a.target,
    createdAt: a.createdAt,
  }

  // No cursor → latest page (newest first then reversed); with cursor → everything after it.
  // A status change moves an alert to a new seq, so the same `id` can reappear: clients upsert by id.
  const rows =
    since === null
      ? (await db.select(columns).from(a).orderBy(desc(a.seq)).limit(PAGE_LIMIT)).reverse()
      : await db.select(columns).from(a).where(gt(a.seq, since)).orderBy(asc(a.seq)).limit(PAGE_LIMIT)

  const alerts: Alert[] = rows.map((r) => ({
    ...r,
    source: r.source as AlertSource,
    severity: r.severity as AlertSeverity,
    status: r.status as AlertStatus,
    createdAt: r.createdAt.toISOString(),
    actions: availableActions(r),
  }))
  // Cursor comes from the rows actually returned (both branches end with the highest seq),
  // so it can never skip past something the client has not received.
  const cursor = alerts.at(-1)?.seq ?? since ?? 0
  const body: AlertsResponse = { alerts, cursor }
  return json(body, 200, cors)
}
