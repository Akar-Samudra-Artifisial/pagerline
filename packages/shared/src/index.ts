// Shared contract between the Pagerline server and the G2 glasses app.

export const ALERT_SOURCES = ['github', 'sentry'] as const
export type AlertSource = (typeof ALERT_SOURCES)[number]

export const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

export const ALERT_STATUSES = ['open', 'acked', 'resolved', 'muted'] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

export interface Alert {
  /** Stable UUID. */
  id: string
  /**
   * Monotonic sequence used as the polling cursor (`GET /api/alerts?since=`).
   * A status change (resolve from the glasses or Sentry, reopen, …) moves the alert to a new,
   * higher `seq`, so the SAME `id` can be returned again with the new `status`:
   * clients must upsert by `id`, never append.
   */
  seq: number
  source: AlertSource
  /** Source-specific kind, e.g. `workflow_run.failure`, `issues.opened`, `sentry.issue`. */
  kind: string
  severity: AlertSeverity
  status: AlertStatus
  title: string
  summary: string
  /** Repository (`owner/name`) or Sentry project slug. */
  scope: string | null
  url: string | null
  /** ISO-8601 timestamp. */
  createdAt: string
  /** Provider object the write actions operate on; null when the alert has none. */
  target?: AlertTarget | null
  /** Write actions the server will accept an intent for (source matrix + allowlist). */
  actions?: ActionKind[]
}

/** GitHub Actions run (`workflow_run.failure` alerts). */
export interface GithubRunTarget {
  repo: string
  runId: number
}

/** Sentry issue (`sentry.*` alerts). `org` falls back to the server's `SENTRY_ORG`. */
export interface SentryIssueTarget {
  org?: string
  project?: string
  issueId: string
}

export type AlertTarget = GithubRunTarget | SentryIssueTarget

export interface AlertsResponse {
  /** Ascending `seq`; may contain alerts seen before (status changed) — upsert by `id`. */
  alerts: Alert[]
  /** Highest `seq` known to the server; pass back as `since` on the next poll. */
  cursor: number
}

/**
 * Tier 1 = low-risk, reversible actions (single confirm).
 * Tier 2 = actions that change CI/incident state (explicit second confirm).
 */
export type ActionTier = 1 | 2

export const TIER1_ACTIONS = ['ack', 'assign', 'comment'] as const
export const TIER2_ACTIONS = ['rerun', 'resolve', 'mute'] as const

export type Tier1Action = (typeof TIER1_ACTIONS)[number]
export type Tier2Action = (typeof TIER2_ACTIONS)[number]
export type AlertAction = Tier1Action | Tier2Action

export function tierOf(action: AlertAction): ActionTier {
  return (TIER1_ACTIONS as readonly string[]).includes(action) ? 1 : 2
}

export interface IntentArgs {
  assignee?: string
  comment?: string
  /** Mute duration in minutes. */
  muteMinutes?: number
}

export interface Intent {
  action: AlertAction
  alertId: string
  tier: ActionTier
  args?: IntentArgs
  /** How the intent was produced on the glasses. */
  origin: 'menu' | 'voice'
  /** Raw transcript when `origin === 'voice'`. */
  transcript?: string
}

// ---------------------------------------------------------------------------
// Write actions (H3): intent → preview + nonce → confirm.

/** Write actions the server actually executes (others in AlertAction are not wired). */
export const ACTION_KINDS = ['rerun', 'resolve'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}

/** Error body for every non-2xx JSON response. */
export interface ApiError {
  error: string
}

/** `POST /api/actions/intent` body. */
export interface ActionIntentRequest {
  alertId: string
  action: ActionKind
}

/** `POST /api/actions/intent` 201 response: what will happen, plus a one-time nonce. */
export interface ActionPreview {
  requestId: string
  /** One-time secret to echo back in confirm; valid until `expiresAt` (60 s). */
  nonce: string
  expiresAt: string
  alertId: string
  action: ActionKind
  /** Short line for the glasses, e.g. `Re-run failed jobs`. */
  headline: string
  /** Target in human form, e.g. `owner/repo · run 123`. */
  target: string
  /** One or two sentences describing the effect. */
  detail: string
  /** True when the server runs with `ACTIONS_DRY_RUN=1` (provider is not called). */
  dryRun: boolean
}

/** `POST /api/actions/confirm` body. */
export interface ActionConfirmRequest {
  requestId: string
  nonce: string
}

export const ACTION_REQUEST_STATUSES = ['pending', 'confirmed', 'expired', 'failed', 'succeeded'] as const
export type ActionRequestStatus = (typeof ACTION_REQUEST_STATUSES)[number]

/**
 * `POST /api/actions/confirm` 200 response (provider errors are `failed`, not HTTP errors).
 * `failed` also covers an allowlist/matrix re-check at confirm time and internal errors;
 * `message` is generic text safe to display (provider details stay in the audit log).
 */
export interface ActionConfirmResult {
  requestId: string
  alertId: string
  action: ActionKind
  status: 'succeeded' | 'failed'
  message: string
  /** HTTP status from GitHub/Sentry; null on dry run or network error. */
  providerStatus: number | null
  dryRun: boolean
  /** Alert status after the action (`resolved` after a successful resolve). */
  alertStatus: AlertStatus
}

// ---------------------------------------------------------------------------
// Device pairing.

/** `POST /api/pair/start` 201 response. Show `code` on the glasses; keep `pollSecret` private. */
export interface PairStartResponse {
  /** 6 characters, A–Z/2–9 without ambiguous glyphs. */
  code: string
  pollSecret: string
  expiresAt: string
  pollIntervalMs: number
}

/** `GET /api/pair/status` (Authorization: Bearer <pollSecret>) 200 response. */
export type PairStatusResponse =
  | { status: 'pending'; expiresAt: string }
  /** Returned exactly once; store `token` and use it as the device bearer token. */
  | { status: 'approved'; deviceId: string; deviceName: string; token: string }
  | { status: 'claimed' }
  | { status: 'expired' }

// ---------------------------------------------------------------------------
// Voice commands (H4) and AI summaries (H5).

/**
 * What a spoken command maps to. `rerun`/`resolve` are NEVER executed by `/api/voice`:
 * the glasses must still call `POST /api/actions/intent` and show the Confirm screen.
 */
export const VOICE_INTENTS = ['rerun', 'resolve', 'next', 'back', 'inbox', 'summary', 'unknown'] as const
export type VoiceIntent = (typeof VOICE_INTENTS)[number]

/**
 * `POST /api/voice[?alertId=&sampleRate=]` 200 response.
 * Body = audio: raw PCM s16le mono (`Content-Type: audio/pcm` or `application/octet-stream`,
 * `sampleRate` default 16000) or a container (`audio/wav`, `audio/webm`, `audio/ogg`, `audio/mpeg`, `audio/mp4`).
 */
export interface VoiceResponse {
  /** Transcript (English, ≤ 200 chars). */
  transcript: string
  intent: VoiceIntent
  /** Echo of the `alertId` context, when given and the alert exists. */
  alertId?: string
}

export type SummarySource = 'ai' | 'cache' | 'fallback'

/** `POST /api/alerts/{id}/summary[?refresh=1]` 200 response. */
export interface SummaryResponse {
  alertId: string
  /** Plain text, ≤ 240 characters. */
  summary: string
  /** `ai` = generated now, `cache` = stored AI summary, `fallback` = heuristic (AI unavailable). */
  source: SummarySource
  /** When the AI summary was generated; null for `fallback`. */
  generatedAt: string | null
}

// ---------------------------------------------------------------------------
// Audit log.

export interface AuditEntry {
  id: number
  /** e.g. `action.intent`, `action.succeeded`, `pair.approved`, `webhook.github`. */
  event: string
  actor: string | null
  alertId: string | null
  detail: Record<string, unknown>
  createdAt: string
}

/** `GET /api/audit?limit=&before=` response, newest first. A device token sees only its own entries. */
export interface AuditResponse {
  entries: AuditEntry[]
  /** Pass as `before` for the next (older) page; null when exhausted. */
  nextBefore: number | null
}
