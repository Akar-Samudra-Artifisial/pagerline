import type { GithubRunTarget } from '@pagerline/shared'
import { obj, str } from './payload'

/** Outcome of a provider write. Provider/network errors are data here, never thrown. */
export interface ProviderOutcome {
  ok: boolean
  /** HTTP status from the provider; null on network error / missing config / dry run. */
  status: number | null
  /** Safe for clients: generic text derived from the status code only. */
  message: string
  /** Provider's own error text, truncated; audit log only, never sent to clients. */
  detail?: string
}

const TIMEOUT_MS = 10_000
const DETAIL_MAX = 200

/** Client-facing message for a provider result, from the status code alone. */
export function publicMessage(label: string, status: number | null, ok: boolean): string {
  if (ok) return `${label}: ok${status === null ? '' : ` (${status})`}`
  if (status === null) return `${label}: provider unreachable or not configured`
  if (status === 401 || status === 403) return `${label}: provider refused (${status}): missing permission or not allowed`
  if (status === 404) return `${label}: not found at provider (404)`
  if (status === 409 || status === 422) return `${label}: provider rejected the request in the current state (${status})`
  if (status === 429) return `${label}: provider rate limit (429), try again later`
  if (status >= 500) return `${label}: provider error (${status}), try again later`
  return `${label}: provider returned ${status}`
}

async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const body = obj(JSON.parse(text))
    const msg = str(body.message) ?? str(body.detail)
    if (msg) return msg.slice(0, DETAIL_MAX)
  } catch {
    // Non-JSON error body: fall through to the raw text.
  }
  return text.slice(0, DETAIL_MAX) || res.statusText || 'request failed'
}

async function call(url: string, init: RequestInit, label: string): Promise<ProviderOutcome> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, status: null, message: publicMessage(label, null, false), detail: `network error: ${reason}`.slice(0, DETAIL_MAX) }
  }
  if (res.ok) return { ok: true, status: res.status, message: publicMessage(label, res.status, true) }
  return { ok: false, status: res.status, message: publicMessage(label, res.status, false), detail: await errorDetail(res) }
}

export const GITHUB_RERUN_LABEL = 'GitHub rerun-failed-jobs'
export const SENTRY_RESOLVE_LABEL = 'Sentry resolve'

/** `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs` (201 on success). */
export async function githubRerunFailedJobs(target: GithubRunTarget): Promise<ProviderOutcome> {
  const token = process.env.GITHUB_ACTIONS_TOKEN
  if (!token) return { ok: false, status: null, message: publicMessage(GITHUB_RERUN_LABEL, null, false), detail: 'GITHUB_ACTIONS_TOKEN not set' }
  const [owner, repo] = target.repo.split('/')
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${target.runId}/rerun-failed-jobs`
  return call(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pagerline-server',
      },
    },
    GITHUB_RERUN_LABEL,
  )
}

/** `PUT /api/0/organizations/{org}/issues/{issue_id}/` with `{status: "resolved"}`. */
export async function sentryResolveIssue(org: string, issueId: string): Promise<ProviderOutcome> {
  const token = process.env.SENTRY_API_TOKEN
  if (!token) return { ok: false, status: null, message: publicMessage(SENTRY_RESOLVE_LABEL, null, false), detail: 'SENTRY_API_TOKEN not set' }
  const url = `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/`
  return call(
    url,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    },
    SENTRY_RESOLVE_LABEL,
  )
}
