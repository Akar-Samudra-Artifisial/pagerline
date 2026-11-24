import type {
  ActionConfirmResult,
  ActionKind,
  ActionPreview,
  AlertStatus,
  AlertTarget,
  GithubRunTarget,
  SentryIssueTarget,
} from '@pagerline/shared'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { audit } from './audit'
import { randomSecret, sha256Hex } from './crypto'
import { setAlertStatus } from './ingest'
import {
  GITHUB_RERUN_LABEL,
  githubRerunFailedJobs,
  publicMessage,
  SENTRY_RESOLVE_LABEL,
  sentryResolveIssue,
  type ProviderOutcome,
} from './providers'

const RATE_WINDOW_MS = 10 * 60_000
const RATE_LIMIT = 10
/** Advisory lock namespace (two-int form) for the per-device intent count + insert. */
const ACTION_RATE_LOCK = 0x504c_02

/** Nonce lifetime: 60 s; `ACTION_NONCE_TTL_SECONDS` (1–300) overrides outside production tests. */
function nonceTtlMs(): number {
  const n = Number(process.env.ACTION_NONCE_TTL_SECONDS ?? '60')
  return (Number.isFinite(n) && n >= 1 && n <= 300 ? n : 60) * 1000
}

export function isDryRun(): boolean {
  return process.env.ACTIONS_DRY_RUN === '1'
}

function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function isGithubTarget(t: AlertTarget | null): t is GithubRunTarget {
  return t !== null && typeof (t as GithubRunTarget).repo === 'string' && Number.isSafeInteger((t as GithubRunTarget).runId)
}

function isSentryTarget(t: AlertTarget | null): t is SentryIssueTarget {
  return t !== null && typeof (t as SentryIssueTarget).issueId === 'string' && /^\d+$/.test((t as SentryIssueTarget).issueId)
}

interface AlertForAction {
  id: string
  source: string
  kind: string
  title: string
  status: string
  target: AlertTarget | null
}

type Check = { ok: true } | { ok: false; status: 403 | 422; error: string }

/** Source/kind matrix: rerun only for GitHub `workflow_run.failure`, resolve only for Sentry. */
function checkMatrix(alert: AlertForAction, action: ActionKind): Check {
  if (action === 'rerun') {
    if (alert.source !== 'github' || alert.kind !== 'workflow_run.failure') {
      return { ok: false, status: 422, error: 'rerun is only available for failed GitHub workflow runs' }
    }
    if (!isGithubTarget(alert.target)) return { ok: false, status: 422, error: 'alert has no workflow run target' }
    return { ok: true }
  }
  if (alert.source !== 'sentry') return { ok: false, status: 422, error: 'resolve is only available for Sentry issues' }
  if (!isSentryTarget(alert.target)) return { ok: false, status: 422, error: 'alert has no Sentry issue target' }
  return { ok: true }
}

/** Server-side allowlists (`GITHUB_ALLOWED_REPOS`, `SENTRY_ORG`, `SENTRY_ALLOWED_PROJECTS`). */
function checkAllowlist(alert: AlertForAction): Check {
  const t = alert.target
  if (isGithubTarget(t)) {
    return csv('GITHUB_ALLOWED_REPOS').includes(t.repo.toLowerCase())
      ? { ok: true }
      : { ok: false, status: 403, error: `repository ${t.repo} is not in the action allowlist` }
  }
  if (isSentryTarget(t)) {
    const org = (process.env.SENTRY_ORG ?? '').trim().toLowerCase()
    if (!org) return { ok: false, status: 403, error: 'Sentry actions are not enabled on this server' }
    if (t.org && t.org.toLowerCase() !== org) return { ok: false, status: 403, error: `Sentry org ${t.org} is not allowed` }
    if (!t.project || !csv('SENTRY_ALLOWED_PROJECTS').includes(t.project.toLowerCase())) {
      return { ok: false, status: 403, error: `Sentry project ${t.project ?? '(unknown)'} is not in the action allowlist` }
    }
    return { ok: true }
  }
  return { ok: false, status: 422, error: 'alert has no action target' }
}

/** Actions the glasses may offer for an alert (matrix + allowlist). */
export function availableActions(alert: AlertForAction): ActionKind[] {
  return (['rerun', 'resolve'] as const).filter((a) => checkMatrix(alert, a).ok && checkAllowlist(alert).ok)
}

function describe(alert: AlertForAction, action: ActionKind): Pick<ActionPreview, 'headline' | 'target' | 'detail'> {
  if (action === 'rerun' && isGithubTarget(alert.target)) {
    return {
      headline: 'Re-run failed jobs',
      target: `${alert.target.repo} · run ${alert.target.runId}`,
      detail: `Starts a new attempt of only the failed jobs in this workflow run. “${alert.title}”`,
    }
  }
  const t = alert.target as SentryIssueTarget
  return {
    headline: 'Resolve Sentry issue',
    target: `${t.project ?? '?'} · issue ${t.issueId}`,
    detail: `Marks the issue resolved in Sentry; it reopens if the error happens again. “${alert.title}”`,
  }
}

export type IntentResult = { ok: true; preview: ActionPreview } | { ok: false; status: 403 | 404 | 422 | 429; error: string }

export async function createIntent(deviceId: string, alertId: string, action: ActionKind): Promise<IntentResult> {
  const db = getDb()
  const a = schema.alerts
  const actor = `device:${deviceId}`
  const [alert] = await db
    .select({ id: a.id, source: a.source, kind: a.kind, title: a.title, status: a.status, target: a.target })
    .from(a)
    .where(eq(a.id, alertId))
    .limit(1)
  if (!alert) return { ok: false, status: 404, error: 'alert not found' }

  const denied = [checkMatrix(alert, action), checkAllowlist(alert)].find((c) => !c.ok)
  if (denied && !denied.ok) {
    await audit({ event: 'action.denied', actor, alertId, detail: { action, reason: denied.error } })
    return { ok: false, status: denied.status, error: denied.error }
  }

  const r = schema.actionRequests
  const nonce = randomSecret(24)
  const expiresAt = new Date(Date.now() + nonceTtlMs())
  // Count + insert under a per-device advisory lock: parallel intents cannot exceed the limit.
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ACTION_RATE_LOCK}::int, hashtext(${deviceId}))`)
    const [{ n }] = await tx
      .select({ n: count() })
      .from(r)
      .where(and(eq(r.deviceId, deviceId), gt(r.createdAt, new Date(Date.now() - RATE_WINDOW_MS))))
    if (n >= RATE_LIMIT) return null
    const [inserted] = await tx
      .insert(r)
      .values({ alertId, deviceId, action, nonceHash: sha256Hex(nonce), expiresAt })
      .returning({ id: r.id })
    return inserted
  })
  if (!row) {
    await audit({ event: 'action.denied', actor, alertId, detail: { action, reason: 'rate limited' } })
    return { ok: false, status: 429, error: `rate limit: ${RATE_LIMIT} actions per 10 minutes per device` }
  }
  const info = describe(alert, action)
  await audit({ event: 'action.intent', actor, alertId, detail: { requestId: row.id, action, target: info.target } })
  return {
    ok: true,
    preview: {
      requestId: row.id,
      nonce,
      expiresAt: expiresAt.toISOString(),
      alertId,
      action,
      ...info,
      dryRun: isDryRun(),
    },
  }
}

export type ConfirmResult =
  | { ok: true; result: ActionConfirmResult }
  | { ok: false; status: 403 | 404 | 409 | 410; error: string }

/**
 * Dry-run stand-in for the provider. A target id (run id / issue id) that starts with `9999`
 * and ends in an HTTP status (e.g. `9999…409`) simulates that provider error, so the
 * failure path is testable without real credentials; anything else succeeds.
 */
function fakeProvider(action: ActionKind, target: AlertTarget | null): ProviderOutcome {
  const label = action === 'rerun' ? GITHUB_RERUN_LABEL : SENTRY_RESOLVE_LABEL
  const id = isGithubTarget(target) ? String(target.runId) : isSentryTarget(target) ? target.issueId : ''
  const simulated = /^9999\d*([1-5]\d\d)$/.exec(id)
  if (simulated) {
    const status = Number(simulated[1])
    return { ok: false, status, message: publicMessage(label, status, false), detail: 'dry run: simulated provider error' }
  }
  return { ok: true, status: null, message: `dry run: ${action} not sent to provider` }
}

async function runProvider(action: ActionKind, target: AlertTarget | null): Promise<ProviderOutcome> {
  if (isDryRun()) return fakeProvider(action, target)
  if (action === 'rerun' && isGithubTarget(target)) return githubRerunFailedJobs(target)
  if (action === 'resolve' && isSentryTarget(target)) {
    return sentryResolveIssue(target.org ?? (process.env.SENTRY_ORG ?? '').trim(), target.issueId)
  }
  return { ok: false, status: null, message: 'alert target no longer matches the action' }
}

export async function confirmIntent(deviceId: string, requestId: string, nonce: string): Promise<ConfirmResult> {
  const db = getDb()
  const r = schema.actionRequests
  const actor = `device:${deviceId}`
  const nonceHash = sha256Hex(nonce)

  // Single atomic transition: only one confirm can win pending → confirmed.
  const [won] = await db
    .update(r)
    .set({ status: 'confirmed' })
    .where(
      and(
        eq(r.id, requestId),
        eq(r.deviceId, deviceId),
        eq(r.nonceHash, nonceHash),
        eq(r.status, 'pending'),
        gt(r.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: r.id, alertId: r.alertId, action: r.action })

  if (!won) {
    const [row] = await db
      .select({ status: r.status, nonceHash: r.nonceHash, expiresAt: r.expiresAt, alertId: r.alertId })
      .from(r)
      .where(and(eq(r.id, requestId), eq(r.deviceId, deviceId)))
      .limit(1)
    if (!row) return { ok: false, status: 404, error: 'action request not found' }
    if (row.nonceHash !== nonceHash) {
      await audit({ event: 'action.denied', actor, alertId: row.alertId, detail: { requestId, reason: 'bad nonce' } })
      return { ok: false, status: 403, error: 'invalid nonce' }
    }
    if (row.status === 'pending' || row.status === 'expired') {
      await db
        .update(r)
        .set({ status: 'expired' })
        .where(and(eq(r.id, requestId), eq(r.status, 'pending')))
      return { ok: false, status: 410, error: 'confirmation expired, start the action again' }
    }
    return { ok: false, status: 409, error: `action request already ${row.status}` }
  }

  const action = won.action as ActionKind
  const dryRun = isDryRun()
  let alertStatus: AlertStatus = 'open'
  let outcome: ProviderOutcome | null = null
  let result: ActionConfirmResult | null = null

  // From here the request is `confirmed`; the finally block always records a terminal status.
  try {
    await audit({ event: 'action.confirm', actor, alertId: won.alertId, detail: { requestId, action } })

    const a = schema.alerts
    const [alert] = await db
      .select({ id: a.id, source: a.source, kind: a.kind, title: a.title, status: a.status, target: a.target })
      .from(a)
      .where(eq(a.id, won.alertId))
      .limit(1)
    if (!alert) {
      outcome = { ok: false, status: null, message: 'alert no longer exists' }
    } else {
      alertStatus = alert.status as AlertStatus
      // Re-check: the allowlist/env or the alert may have changed since the intent.
      const denied = [checkMatrix(alert, action), checkAllowlist(alert)].find((c) => !c.ok)
      if (denied && !denied.ok) {
        outcome = { ok: false, status: null, message: `no longer allowed: ${denied.error}` }
        await audit({ event: 'action.denied', actor, alertId: alert.id, detail: { requestId, action, reason: denied.error } })
      } else {
        outcome = await runProvider(action, alert.target)
        if (outcome.ok && action === 'resolve') {
          await setAlertStatus(alert.id, 'resolved')
          alertStatus = 'resolved'
        }
      }
    }
    result = toResult(requestId, won.alertId, action, outcome, dryRun, alertStatus)
  } catch (err) {
    console.error(`[pagerline] confirm ${requestId} failed:`, err instanceof Error ? err.message : err)
    const message = outcome?.ok
      ? 'the provider accepted the action, but the server failed to record it'
      : 'internal error while running the action'
    outcome = { ok: false, status: outcome?.status ?? null, message, detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown error' }
    result = toResult(requestId, won.alertId, action, outcome, dryRun, alertStatus)
  } finally {
    const final = result ?? toResult(requestId, won.alertId, action, null, dryRun, alertStatus)
    await db
      .update(r)
      .set({ status: final.status, result: final })
      .where(and(eq(r.id, requestId), eq(r.status, 'confirmed')))
  }

  await audit({
    event: `action.${result.status}`,
    actor,
    alertId: won.alertId,
    detail: {
      requestId,
      action,
      providerStatus: result.providerStatus,
      message: result.message,
      ...(outcome?.detail ? { providerDetail: outcome.detail.slice(0, 200) } : {}),
      dryRun,
    },
  })
  return { ok: true, result }
}

function toResult(
  requestId: string,
  alertId: string,
  action: ActionKind,
  outcome: ProviderOutcome | null,
  dryRun: boolean,
  alertStatus: AlertStatus,
): ActionConfirmResult {
  return {
    requestId,
    alertId,
    action,
    status: outcome?.ok ? 'succeeded' : 'failed',
    message: outcome?.message ?? 'internal error while running the action',
    providerStatus: outcome?.status ?? null,
    dryRun,
    alertStatus,
  }
}
