import type { AlertSeverity, SentryIssueTarget } from '@pagerline/shared'
import { truncate, type NormalizedAlert } from './ingest'
import { obj, str, type Json } from './payload'

function levelToSeverity(level: string | null): AlertSeverity {
  switch (level) {
    case 'fatal':
      return 'critical'
    case 'error':
      return 'high'
    case 'warning':
      return 'medium'
    case 'info':
    case 'debug':
      return 'info'
    default:
      return 'medium'
  }
}

/** Sentry ids arrive as strings or numbers depending on resource. */
function idOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return str(value)
}

/** `issue:<id>` so an `issue` webhook and an `event_alert`/`error` for the same issue yield one alert. */
function issueKey(issueId: string | null, url: string | null): string | null {
  const id = issueId ?? (url ? (/\/issues\/(\d+)\//.exec(url)?.[1] ?? null) : null)
  return id ? `issue:${id}` : null
}

/** Org slug from `https://<org>.sentry.io/...` (region hosts `us`/`de` carry no org). */
function orgFromWebUrl(url: string | null): string | null {
  const org = url ? (/^https:\/\/([a-z0-9-]+)\.sentry\.io\//.exec(url)?.[1] ?? null) : null
  return org === 'us' || org === 'de' ? null : org
}

/** `{org, project}` from an API url like `https://sentry.io/api/0/projects/<org>/<project>/events/<id>/`. */
function fromApiUrl(url: string | null): { org: string | null; project: string | null } {
  const m = url ? /\/projects\/([^/]+)\/([^/]+)\//.exec(url) : null
  return { org: m?.[1] ?? null, project: m?.[2] ?? null }
}

function issueTarget(
  issueId: string | null,
  org: string | null,
  project: string | null,
): SentryIssueTarget | null {
  if (!issueId) return null
  return { issueId, ...(org ? { org } : {}), ...(project ? { project } : {}) }
}

/**
 * Map a Sentry integration-platform webhook (`Sentry-Hook-Resource`) to an alert,
 * or return a reason string when it is not alert-worthy.
 */
export function normalizeSentry(resource: string, payload: Json): NormalizedAlert | string {
  const action = str(payload.action)
  const data = obj(payload.data)

  if (resource === 'issue') {
    if (action !== 'created' && action !== 'unresolved' && action !== 'resolved') {
      return `issue.${action ?? 'unknown'} ignored`
    }
    const issue = obj(data.issue)
    const project = str(obj(issue.project).slug)
    const url = str(issue.web_url) ?? str(issue.permalink)
    return {
      // `created` keeps whatever status an existing alert has; `unresolved` reopens it (or
      // creates one); `resolved` (from the Sentry UI or our own action) only updates.
      ...(action === 'unresolved' ? { status: 'open' as const } : {}),
      ...(action === 'resolved' ? { status: 'resolved' as const, updateOnly: true } : {}),
      kind: `sentry.issue.${action}`,
      severity: levelToSeverity(str(issue.level)),
      title: truncate(str(issue.title) ?? 'Sentry issue', 120),
      summary: truncate([project, str(issue.culprit), str(issue.shortId)].filter(Boolean).join(' · '), 600),
      scope: project,
      url,
      dedupKey: issueKey(idOf(issue.id), url),
      target: issueTarget(
        idOf(issue.id) ?? (url ? (/\/issues\/(\d+)\//.exec(url)?.[1] ?? null) : null),
        orgFromWebUrl(url),
        project,
      ),
    }
  }

  if (resource === 'event_alert' || resource === 'error') {
    const ev = obj(data.event ?? data.error)
    const rule = str(data.triggered_rule)
    const url = str(ev.web_url) ?? str(ev.url)
    const api = fromApiUrl(str(ev.url))
    const issueId = idOf(ev.issue_id) ?? (/\/issues\/(\d+)\//.exec(str(ev.web_url) ?? '')?.[1] ?? null)
    return {
      kind: `sentry.${resource}`,
      severity: levelToSeverity(str(ev.level)),
      title: truncate(str(ev.title) ?? str(ev.message) ?? 'Sentry event', 120),
      summary: truncate([rule ? `rule: ${rule}` : null, str(ev.culprit)].filter(Boolean).join(' · '), 600),
      scope: str(ev.project) ?? null,
      url,
      dedupKey: issueKey(idOf(ev.issue_id), str(ev.web_url)),
      target: issueTarget(issueId, orgFromWebUrl(str(ev.web_url)) ?? api.org, str(ev.project) ?? api.project),
    }
  }

  if (resource === 'installation') return 'installation'
  return `resource ${resource} not handled`
}
