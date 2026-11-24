import type { GithubRunTarget } from '@pagerline/shared'
import { truncate, type NormalizedAlert } from './ingest'
import { num, obj, str, type Json } from './payload'

/** `{repo, runId}` from a workflow_run; run id falls back to the `/actions/runs/<id>` html_url. */
function runTarget(repo: string | null, run: Json): GithubRunTarget | null {
  const fromUrl = /\/actions\/runs\/(\d+)/.exec(str(run.html_url) ?? '')?.[1]
  const runId = num(run.id) ?? (fromUrl ? Number(fromUrl) : null)
  return repo && runId !== null && Number.isSafeInteger(runId) ? { repo, runId } : null
}

/**
 * Map a GitHub webhook to an alert, or return a reason string when the event
 * is valid but not alert-worthy.
 */
export function normalizeGithub(event: string, payload: Json): NormalizedAlert | string {
  const repo = str(obj(payload.repository).full_name)
  const action = str(payload.action)

  if (event === 'workflow_run') {
    const run = obj(payload.workflow_run)
    if (action !== 'completed') return `workflow_run.${action ?? 'unknown'} ignored`
    if (str(run.conclusion) !== 'failure') return `workflow_run conclusion=${str(run.conclusion) ?? 'none'} ignored`
    const name = str(run.name) ?? 'workflow'
    const branch = str(run.head_branch) ?? '?'
    const commit = str(obj(run.head_commit).message) ?? ''
    const actor = str(obj(run.actor).login)
    return {
      kind: 'workflow_run.failure',
      severity: branch === 'main' || branch === 'master' ? 'high' : 'medium',
      title: truncate(`CI failed: ${name} on ${branch}`, 120),
      summary: truncate(
        [repo, actor ? `by ${actor}` : null, commit ? `"${commit.split('\n')[0]}"` : null].filter(Boolean).join(' · '),
        600,
      ),
      scope: repo,
      url: str(run.html_url),
      dedupKey: null,
      target: runTarget(repo, run),
    }
  }

  if (event === 'issues') {
    if (action !== 'opened' && action !== 'reopened') return `issues.${action ?? 'unknown'} ignored`
    const issue = obj(payload.issue)
    const labels = Array.isArray(issue.labels) ? issue.labels.map((l) => str(obj(l).name)).filter(Boolean) : []
    const urgent = labels.some((l) => /^(p0|sev1|incident|urgent|critical)$/i.test(String(l)))
    const number = issue.number
    return {
      kind: `issues.${action}`,
      severity: urgent ? 'high' : 'low',
      title: truncate(`#${String(number ?? '?')} ${str(issue.title) ?? 'Untitled issue'}`, 120),
      summary: truncate(
        [repo, str(obj(issue.user).login) ? `by ${str(obj(issue.user).login)}` : null, str(issue.body)]
          .filter(Boolean)
          .join(' · '),
        600,
      ),
      scope: repo,
      url: str(issue.html_url),
      dedupKey: null,
      target: null,
    }
  }

  if (event === 'ping') return 'ping'
  return `event ${event} not handled`
}
