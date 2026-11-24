// Send signed fake GitHub + Sentry webhooks to a local Pagerline server.
//   pnpm seed              → seed demo alerts (fresh delivery ids each run)
//   pnpm seed --selftest   → also assert bad signature → 401 and redelivery → no duplicate row
import { createHmac, randomUUID } from 'node:crypto'

const SERVER = process.env.SERVER_URL ?? 'http://localhost:3300'
const GH_SECRET = process.env.GITHUB_WEBHOOK_SECRET
const SENTRY_SECRET = process.env.SENTRY_CLIENT_SECRET
const selftest = process.argv.includes('--selftest')

if (!GH_SECRET || !SENTRY_SECRET) {
  console.error('GITHUB_WEBHOOK_SECRET and SENTRY_CLIENT_SECRET must be set (apps/server/.env.local)')
  process.exit(1)
}

const hmac = (secret, body) => createHmac('sha256', secret).update(body, 'utf8').digest('hex')

async function sendGithub(event, payload, { deliveryId = randomUUID(), secret = GH_SECRET } = {}) {
  const body = JSON.stringify(payload)
  const res = await fetch(`${SERVER}/api/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': `sha256=${hmac(secret, body)}`,
    },
    body,
  })
  return { status: res.status, body: await res.json(), deliveryId }
}

async function sendSentry(
  resource,
  payload,
  { deliveryId = randomUUID(), secret = SENTRY_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {},
) {
  const body = JSON.stringify(payload)
  const res = await fetch(`${SERVER}/api/webhooks/sentry`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sentry-hook-resource': resource,
      'sentry-hook-timestamp': String(timestamp),
      'request-id': deliveryId,
      'sentry-hook-signature': hmac(secret, body),
    },
    body,
  })
  return { status: res.status, body: await res.json(), deliveryId }
}

const repo = { full_name: 'acme/checkout-api' }

const workflowFailure = {
  action: 'completed',
  repository: repo,
  workflow_run: {
    name: 'CI / test',
    conclusion: 'failure',
    head_branch: 'main',
    html_url: 'https://github.com/acme/checkout-api/actions/runs/1001',
    actor: { login: 'rina' },
    head_commit: { message: 'Bump payment SDK to 4.2\n\nCo-authored-by: bot' },
  },
}

const issueOpened = {
  action: 'opened',
  repository: repo,
  issue: {
    number: 482,
    title: 'Checkout returns 502 for EU customers',
    html_url: 'https://github.com/acme/checkout-api/issues/482',
    user: { login: 'support-bot' },
    labels: [{ name: 'P0' }],
    body: 'Since 09:40 UTC, ~12% of EU checkout requests fail with 502 from the payments proxy.',
  },
}

// Fresh Sentry issue ids per run so repeated seeds create new alerts (alerts dedup per issue id).
const issueA = String(Date.now())
const issueB = String(Date.now() + 1)

const sentryIssue = {
  action: 'created',
  data: {
    issue: {
      id: issueA,
      title: "TypeError: Cannot read properties of undefined (reading 'amount')",
      culprit: 'src/payments/capture.ts in captureCharge',
      shortId: 'CHECKOUT-API-7F',
      level: 'error',
      project: { slug: 'checkout-api' },
      web_url: `https://acme.sentry.io/issues/${issueA}/`,
    },
  },
}

const sentryEventAlert = {
  action: 'triggered',
  data: {
    triggered_rule: 'Error rate > 5% for 5m',
    event: {
      issue_id: issueB,
      title: 'Error rate spike on /v1/checkout',
      level: 'fatal',
      culprit: 'POST /v1/checkout',
      web_url: `https://acme.sentry.io/issues/${issueB}/events/abc/`,
    },
  },
}

let failed = false
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${JSON.stringify(detail)}`)
  if (!ok) failed = true
}

const gh1 = await sendGithub('workflow_run', workflowFailure)
check('github workflow_run.failure', gh1.status === 201, gh1)
const gh2 = await sendGithub('issues', issueOpened)
check('github issues.opened', gh2.status === 201, gh2)
const s1 = await sendSentry('issue', sentryIssue)
check('sentry issue.created', s1.status === 201, s1)
const s2 = await sendSentry('event_alert', sentryEventAlert)
check('sentry event_alert', s2.status === 201, s2)

if (selftest) {
  const badGh = await sendGithub('issues', issueOpened, { secret: 'wrong-secret' })
  check('github bad signature → 401', badGh.status === 401, badGh)
  const badSentry = await sendSentry('issue', sentryIssue, { secret: 'wrong-secret' })
  check('sentry bad signature → 401', badSentry.status === 401, badSentry)

  const dupGh = await sendGithub('workflow_run', workflowFailure, { deliveryId: gh1.deliveryId })
  check('github redelivery → duplicate', dupGh.status === 200 && dupGh.body.status === 'duplicate', dupGh)
  const dupSentry = await sendSentry('issue', sentryIssue, { deliveryId: s1.deliveryId })
  check('sentry redelivery → duplicate', dupSentry.status === 200 && dupSentry.body.status === 'duplicate', dupSentry)

  const ignored = await sendGithub('workflow_run', {
    ...workflowFailure,
    workflow_run: { ...workflowFailure.workflow_run, conclusion: 'success' },
  })
  check('github workflow success → ignored', ignored.status === 202, ignored)

  // event_alert for the issue already alerted by s1 → same alert, not a second one.
  const sameIssue = await sendSentry('event_alert', {
    ...sentryEventAlert,
    data: { ...sentryEventAlert.data, event: { ...sentryEventAlert.data.event, issue_id: issueA } },
  })
  check(
    'sentry event_alert for same issue → duplicate',
    sameIssue.status === 200 && sameIssue.body.status === 'duplicate',
    sameIssue,
  )

  const stale = await sendSentry('issue', sentryIssue, { timestamp: Math.floor(Date.now() / 1000) - 600 })
  check('sentry stale timestamp (10 min) → 401', stale.status === 401, stale)

  const big = { ...issueOpened, padding: 'x'.repeat(1024 * 1024 + 1) }
  const tooLargeGh = await sendGithub('issues', big)
  check('github body > 1 MB → 413', tooLargeGh.status === 413, { status: tooLargeGh.status, body: tooLargeGh.body })
  const tooLargeSentry = await sendSentry('issue', big)
  check('sentry body > 1 MB → 413', tooLargeSentry.status === 413, {
    status: tooLargeSentry.status,
    body: tooLargeSentry.body,
  })
}

process.exit(failed ? 1 : 0)
