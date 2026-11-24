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
  /** Monotonic sequence used as the polling cursor (`GET /api/alerts?since=`). */
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
}

export interface AlertsResponse {
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
