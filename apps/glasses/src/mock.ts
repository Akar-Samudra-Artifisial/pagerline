import type {
  ActionConfirmResult,
  ActionKind,
  ActionPreview,
  Alert,
  PairStartResponse,
  PairStatusResponse,
  SummaryResponse,
  VoiceIntent,
  VoiceResponse,
} from '@pagerline/shared'
import { ApiError } from './errors'

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()

/** Offline demo data used when no server is configured (VITE_MOCK=1 or no VITE_API_BASE). */
export const MOCK_ALERTS: Alert[] = [
  {
    id: 'mock-1',
    seq: 1,
    source: 'github',
    kind: 'workflow_run.failure',
    severity: 'high',
    status: 'open',
    title: 'CI failed: CI / test on main',
    summary: 'acme/checkout-api · by rina · "Bump payment SDK to 4.2"',
    scope: 'acme/checkout-api',
    url: null,
    createdAt: ago(14),
    target: { repo: 'acme/checkout-api', runId: 9912345 },
    actions: ['rerun'],
  },
  {
    id: 'mock-2',
    seq: 2,
    source: 'sentry',
    kind: 'sentry.issue.created',
    severity: 'high',
    status: 'open',
    title: "TypeError: Cannot read properties of undefined (reading 'amount')",
    summary: 'checkout-api · src/payments/capture.ts in captureCharge · CHECKOUT-API-7F',
    scope: 'checkout-api',
    url: null,
    createdAt: ago(6),
    target: { org: 'acme', project: 'checkout-api', issueId: '4711' },
    actions: ['resolve'],
  },
  {
    id: 'mock-3',
    seq: 3,
    source: 'sentry',
    kind: 'sentry.event_alert',
    severity: 'critical',
    status: 'open',
    title: 'Error rate spike on /v1/checkout',
    summary: 'rule: Error rate > 5% for 5m · POST /v1/checkout',
    scope: null,
    url: null,
    createdAt: ago(2),
    target: null,
    actions: [],
  },
]

// ---- pairing: auto-approves a few seconds after the code is shown ----------

const MOCK_APPROVE_AFTER_MS = 4000
const mockPairings = new Map<string, number>()

export function mockPairStart(): PairStartResponse {
  const pollSecret = `mock-poll-${mockPairings.size + 1}`
  mockPairings.set(pollSecret, Date.now())
  return {
    code: 'MOCK42',
    pollSecret,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    pollIntervalMs: 1000,
  }
}

export function mockPairStatus(pollSecret: string): PairStatusResponse {
  const startedAt = mockPairings.get(pollSecret)
  if (startedAt === undefined) return { status: 'expired' }
  if (Date.now() - startedAt < MOCK_APPROVE_AFTER_MS) {
    return { status: 'pending', expiresAt: new Date(startedAt + 10 * 60_000).toISOString() }
  }
  mockPairings.delete(pollSecret)
  return { status: 'approved', deviceId: 'mock-device', deviceName: 'Mock G2', token: 'mock-device-token' }
}

// ---- write actions: same intent → nonce → confirm flow as the server ---------

const MOCK_TTL_MS = 60_000
const mockRequests = new Map<string, { nonce: string; alertId: string; action: ActionKind; expiresAt: number }>()
let mockSeq = 0

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function mockIntent(alertId: string, action: ActionKind): Promise<ActionPreview> {
  await delay(300)
  const alert = MOCK_ALERTS.find((a) => a.id === alertId)
  if (!alert) throw new ApiError(404, 'alert not found')
  if (!alert.actions?.includes(action)) throw new ApiError(422, `${action} is not available for this alert`)
  const requestId = `mock-req-${++mockSeq}`
  const nonce = `mock-nonce-${mockSeq}`
  const expiresAt = Date.now() + MOCK_TTL_MS
  mockRequests.set(requestId, { nonce, alertId, action, expiresAt })
  const t = alert.target
  const isRerun = action === 'rerun'
  return {
    requestId,
    nonce,
    expiresAt: new Date(expiresAt).toISOString(),
    alertId,
    action,
    headline: isRerun ? 'Re-run failed jobs' : 'Resolve Sentry issue',
    target:
      t && 'runId' in t ? `${t.repo} · run ${t.runId}` : t && 'issueId' in t ? `${t.project ?? '?'} · issue ${t.issueId}` : '?',
    detail: isRerun
      ? 'Starts a new attempt of only the failed jobs in this workflow run.'
      : 'Marks the issue resolved in Sentry; it reopens if the error happens again.',
    dryRun: true,
  }
}

// ---- voice + summary -----------------------------------------------------------

/**
 * Mock "speech": each recording yields the next command in this script, so every
 * intent can be demoed without a microphone. `{action}` = the alert's first action.
 */
const MOCK_VOICE_SCRIPT: { transcript: string; intent: VoiceIntent | 'action' }[] = [
  { transcript: 'summarize this', intent: 'summary' },
  { transcript: '{action} it', intent: 'action' },
  { transcript: 'next alert', intent: 'next' },
  { transcript: 'banana pancakes', intent: 'unknown' },
  { transcript: 'go back', intent: 'back' },
]
let mockVoiceTurn = 0

export async function mockVoice(alertId: string): Promise<VoiceResponse> {
  await delay(700)
  const alert = MOCK_ALERTS.find((a) => a.id === alertId)
  const step = MOCK_VOICE_SCRIPT[mockVoiceTurn++ % MOCK_VOICE_SCRIPT.length]
  const action = alert?.actions?.[0]
  if (step.intent === 'action') {
    // Alerts without an action: the "command" is simply not understood.
    if (!action) return { transcript: 'fix it', intent: 'unknown', alertId }
    return { transcript: step.transcript.replace('{action}', action), intent: action, alertId }
  }
  return { transcript: step.transcript, intent: step.intent, alertId }
}

const mockSummaryAt = new Map<string, string>()

export async function mockSummary(alertId: string, refresh: boolean): Promise<SummaryResponse> {
  await delay(900)
  const alert = MOCK_ALERTS.find((a) => a.id === alertId)
  if (!alert) throw new ApiError(404, 'alert not found')
  const cached = mockSummaryAt.get(alertId)
  const generatedAt = !cached || refresh ? new Date().toISOString() : cached
  mockSummaryAt.set(alertId, generatedAt)
  const summary = `Mock summary: ${alert.title}. ${alert.summary}`.slice(0, 240)
  return { alertId, summary, source: cached && !refresh ? 'cache' : 'ai', generatedAt }
}

export async function mockConfirm(requestId: string, nonce: string): Promise<ActionConfirmResult> {
  await delay(600)
  const req = mockRequests.get(requestId)
  if (!req) throw new ApiError(404, 'action request not found')
  if (req.nonce !== nonce) throw new ApiError(403, 'invalid nonce')
  mockRequests.delete(requestId)
  if (Date.now() > req.expiresAt) throw new ApiError(410, 'action request expired')
  const alert = MOCK_ALERTS.find((a) => a.id === req.alertId)
  if (alert && req.action === 'resolve') alert.status = 'resolved'
  return {
    requestId,
    alertId: req.alertId,
    action: req.action,
    status: 'succeeded',
    message: `mock: ${req.action} accepted`,
    providerStatus: null,
    dryRun: true,
    alertStatus: alert?.status ?? 'open',
  }
}
