// Send signed fake GitHub + Sentry webhooks to a local Pagerline server.
//   pnpm seed              → seed demo alerts (fresh delivery ids each run)
//   pnpm seed --selftest   → also assert bad signature → 401 and redelivery → no duplicate row,
//                            plus pairing + write actions (needs ADMIN_SECRET and a dry-run server, see actionSelftest)
import { createHmac, randomUUID } from 'node:crypto'

const SERVER = process.env.SERVER_URL ?? 'http://localhost:3300'
const GH_SECRET = process.env.GITHUB_WEBHOOK_SECRET
const SENTRY_SECRET = process.env.SENTRY_CLIENT_SECRET
const selftest = process.argv.includes('--selftest')
// Unique fake client IP per run (honoured by the dev server only) so per-IP limits never
// carry over between selftest runs.
const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`
const RUN_IP = randomIp()

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

const runId = Date.now()
const workflowFailure = {
  action: 'completed',
  repository: repo,
  workflow_run: {
    id: runId,
    name: 'CI / test',
    conclusion: 'failure',
    head_branch: 'main',
    html_url: `https://github.com/acme/checkout-api/actions/runs/${runId}`,
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

  await actionSelftest()
}

// ---------------------------------------------------------------------------
// H3: pairing, write actions (run the server with ACTIONS_DRY_RUN=1,
// GITHUB_ALLOWED_REPOS=acme/checkout-api, SENTRY_ORG=acme, SENTRY_ALLOWED_PROJECTS=checkout-api).

async function api(method, path, { token, body, ip = RUN_IP } = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      'x-forwarded-for': ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text.slice(0, 200)
  }
  return { status: res.status, body: json }
}

/** Short view for logs: never print tokens/nonces/poll secrets. */
function redact(r) {
  return {
    status: r.status,
    body:
      r.body && typeof r.body === 'object'
        ? Object.fromEntries(
            Object.entries(r.body).map(([k, v]) => [k, /token|nonce|pollSecret/i.test(k) ? '<redacted>' : v]),
          )
        : r.body,
  }
}

async function pairDevice(adminSecret, name) {
  const start = await api('POST', '/api/pair/start')
  if (start.status !== 201) return { start }
  const approve = await api('POST', '/api/admin/pair/approve', {
    token: adminSecret,
    body: { code: start.body.code, name },
  })
  const status = await api('GET', '/api/pair/status', { token: start.body.pollSecret })
  return { start, approve, status, token: status.body?.token, deviceId: status.body?.deviceId }
}

async function actionSelftest() {
  const ADMIN = process.env.ADMIN_SECRET
  const STATIC = process.env.DEVICE_TOKEN
  if (!ADMIN) {
    check('ADMIN_SECRET set for action selftest', false, 'export ADMIN_SECRET (same as the server)')
    return
  }
  const ghAlert = gh1.body.id
  const issueAlert = gh2.body.id
  const sentryAlert = s1.body.id

  // Pairing end-to-end.
  const start = await api('POST', '/api/pair/start')
  check(
    'pair start → 201 + 6-char code',
    start.status === 201 && /^[A-Z2-9]{6}$/.test(start.body.code) && typeof start.body.pollSecret === 'string',
    redact(start),
  )
  const pending = await api('GET', '/api/pair/status', { token: start.body.pollSecret })
  check('pair status before approve → pending', pending.status === 200 && pending.body.status === 'pending', pending)
  const unknownPoll = await api('GET', '/api/pair/status', { token: 'not-a-poll-secret' })
  check('pair status unknown poll secret → 401', unknownPoll.status === 401, unknownPoll)
  const badAdmin = await api('POST', '/api/admin/pair/approve', { token: 'wrong', body: { code: start.body.code } })
  check('approve with wrong admin secret → 401', badAdmin.status === 401, badAdmin)
  const approve = await api('POST', '/api/admin/pair/approve', {
    token: ADMIN,
    body: { code: start.body.code.toLowerCase(), name: 'selftest A' },
  })
  check('approve code → 200', approve.status === 200 && approve.body.ok === true, approve)
  const again = await api('POST', '/api/admin/pair/approve', { token: ADMIN, body: { code: start.body.code } })
  check('approve same code twice → 404', again.status === 404, again)
  const claimed = await api('GET', '/api/pair/status', { token: start.body.pollSecret })
  check(
    'pair status after approve → token once',
    claimed.status === 200 && claimed.body.status === 'approved' && typeof claimed.body.token === 'string',
    redact(claimed),
  )
  const token = claimed.body.token
  const deviceId = claimed.body.deviceId
  const claimedAgain = await api('GET', '/api/pair/status', { token: start.body.pollSecret })
  check(
    'pair status second poll → claimed, no token',
    claimedAgain.status === 200 && claimedAgain.body.status === 'claimed' && !('token' in claimedAgain.body),
    claimedAgain,
  )

  const alerts = await api('GET', '/api/alerts', { token })
  const ghRow = alerts.body?.alerts?.find((a) => a.id === ghAlert)
  check(
    'paired token reads alerts; workflow alert has target + rerun',
    alerts.status === 200 && ghRow?.target?.runId === runId && ghRow.actions.includes('rerun'),
    { status: alerts.status, target: ghRow?.target, actions: ghRow?.actions },
  )

  // Static DEVICE_TOKEN: read-only outside production.
  if (STATIC) {
    const staticRead = await api('GET', '/api/alerts?since=0', { token: STATIC })
    check('static DEVICE_TOKEN can read alerts (dev)', staticRead.status === 200, { status: staticRead.status })
    const staticWrite = await api('POST', '/api/actions/intent', {
      token: STATIC,
      body: { alertId: ghAlert, action: 'rerun' },
    })
    check('static DEVICE_TOKEN rejected for actions → 403', staticWrite.status === 403, staticWrite)
  } else {
    check('DEVICE_TOKEN set for static-token test', false, 'DEVICE_TOKEN missing')
  }
  const noAuth = await api('POST', '/api/actions/intent', { body: { alertId: ghAlert, action: 'rerun' } })
  check('intent without token → 401', noAuth.status === 401, noAuth)

  // Happy path rerun (dry run) + double confirm.
  const intent = await api('POST', '/api/actions/intent', { token, body: { alertId: ghAlert, action: 'rerun' } })
  check(
    'intent rerun → 201 preview + nonce',
    intent.status === 201 && intent.body.headline && typeof intent.body.nonce === 'string' && intent.body.dryRun === true,
    redact(intent),
  )
  const wrongNonce = await api('POST', '/api/actions/confirm', {
    token,
    body: { requestId: intent.body.requestId, nonce: 'wrong-nonce' },
  })
  check('confirm with wrong nonce → 403', wrongNonce.status === 403, wrongNonce)
  const confirm = await api('POST', '/api/actions/confirm', {
    token,
    body: { requestId: intent.body.requestId, nonce: intent.body.nonce },
  })
  check('confirm rerun → 200 succeeded (dry run)', confirm.status === 200 && confirm.body.status === 'succeeded', confirm)
  const confirm2 = await api('POST', '/api/actions/confirm', {
    token,
    body: { requestId: intent.body.requestId, nonce: intent.body.nonce },
  })
  check('second confirm → 409', confirm2.status === 409, confirm2)

  // Parallel confirms of one intent: exactly one wins.
  const race = await api('POST', '/api/actions/intent', { token, body: { alertId: ghAlert, action: 'rerun' } })
  const raceBody = { requestId: race.body.requestId, nonce: race.body.nonce }
  const raced = await Promise.all(
    Array.from({ length: 5 }, () => api('POST', '/api/actions/confirm', { token, body: raceBody })),
  )
  const raceStatuses = raced.map((r) => r.status).sort()
  check(
    'parallel confirms → exactly one 200, rest 409',
    race.status === 201 && raceStatuses.filter((s) => s === 200).length === 1 && raceStatuses.filter((s) => s === 409).length === 4,
    raceStatuses,
  )

  // Source matrix.
  const rerunSentry = await api('POST', '/api/actions/intent', { token, body: { alertId: sentryAlert, action: 'rerun' } })
  check('rerun on Sentry alert → 422', rerunSentry.status === 422, rerunSentry)
  const resolveGh = await api('POST', '/api/actions/intent', { token, body: { alertId: ghAlert, action: 'resolve' } })
  check('resolve on GitHub alert → 422', resolveGh.status === 422, resolveGh)
  const rerunIssue = await api('POST', '/api/actions/intent', { token, body: { alertId: issueAlert, action: 'rerun' } })
  check('rerun on GitHub issues alert → 422', rerunIssue.status === 422, rerunIssue)
  const badAction = await api('POST', '/api/actions/intent', { token, body: { alertId: ghAlert, action: 'delete' } })
  check('unknown action → 400', badAction.status === 400, badAction)

  // Allowlist.
  const evilRun = Date.now() + 7
  const evil = await sendGithub('workflow_run', {
    ...workflowFailure,
    repository: { full_name: 'evil-corp/other-repo' },
    workflow_run: { ...workflowFailure.workflow_run, id: evilRun, html_url: `https://github.com/evil-corp/other-repo/actions/runs/${evilRun}` },
  })
  const evilIntent = await api('POST', '/api/actions/intent', { token, body: { alertId: evil.body.id, action: 'rerun' } })
  check('rerun on repo outside allowlist → 403', evil.status === 201 && evilIntent.status === 403, evilIntent)

  // Expired nonce.
  const expiring = await api('POST', '/api/actions/intent', { token, body: { alertId: sentryAlert, action: 'resolve' } })
  const waitMs = new Date(expiring.body.expiresAt).getTime() - Date.now() + 1000
  if (expiring.status === 201 && waitMs <= 70_000) {
    console.log(`…waiting ${Math.ceil(waitMs / 1000)}s for the nonce to expire`)
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 0)))
    const late = await api('POST', '/api/actions/confirm', {
      token,
      body: { requestId: expiring.body.requestId, nonce: expiring.body.nonce },
    })
    check('confirm after nonce expiry → 410', late.status === 410, late)
  } else {
    check('expiring intent created', false, redact(expiring))
  }

  // Resolve happy path; the status change must reach a client polling with `since`.
  const latest = await api('GET', '/api/alerts', { token })
  const cursorBefore = latest.body?.cursor ?? 0
  const seqBefore = latest.body?.alerts?.find((a) => a.id === sentryAlert)?.seq ?? null
  const resolve = await api('POST', '/api/actions/intent', { token, body: { alertId: sentryAlert, action: 'resolve' } })
  const resolved = await api('POST', '/api/actions/confirm', {
    token,
    body: { requestId: resolve.body.requestId, nonce: resolve.body.nonce },
  })
  check(
    'resolve Sentry issue → succeeded, alert resolved',
    resolved.status === 200 && resolved.body.status === 'succeeded' && resolved.body.alertStatus === 'resolved',
    resolved,
  )
  const polled = await api('GET', `/api/alerts?since=${cursorBefore}`, { token })
  const polledRow = polled.body?.alerts?.find((a) => a.id === sentryAlert)
  check(
    'poll ?since= after resolve → same id again, status resolved, higher seq',
    polled.status === 200 && polledRow?.status === 'resolved' && polledRow.seq > cursorBefore && polledRow.seq !== seqBefore,
    { status: polled.status, seqBefore, cursorBefore, row: polledRow && { seq: polledRow.seq, status: polledRow.status } },
  )

  // Sentry reopen / resolve webhooks update the existing alert (and re-sequence it).
  const issueWebhook = (action) => ({ ...sentryIssue, action })
  const reopen = await sendSentry('issue', issueWebhook('unresolved'))
  check(
    'sentry issue.unresolved → alert updated to open',
    reopen.status === 200 && reopen.body.status === 'updated' && reopen.body.id === sentryAlert && reopen.body.alertStatus === 'open',
    reopen,
  )
  const reopenRedelivery = await sendSentry('issue', issueWebhook('unresolved'), { deliveryId: reopen.deliveryId })
  check('sentry issue.unresolved redelivery → duplicate', reopenRedelivery.body?.status === 'duplicate', reopenRedelivery)
  const polledReopen = await api('GET', `/api/alerts?since=${polledRow?.seq ?? cursorBefore}`, { token })
  const reopenedRow = polledReopen.body?.alerts?.find((a) => a.id === sentryAlert)
  check('poll ?since= after reopen → status open', reopenedRow?.status === 'open' && reopenedRow.seq === reopen.body.seq, {
    row: reopenedRow && { seq: reopenedRow.seq, status: reopenedRow.status },
  })
  const uiResolve = await sendSentry('issue', issueWebhook('resolved'))
  check(
    'sentry issue.resolved (Sentry UI) → alert updated to resolved',
    uiResolve.status === 200 && uiResolve.body.status === 'updated' && uiResolve.body.alertStatus === 'resolved',
    uiResolve,
  )
  const uiResolveAgain = await sendSentry('issue', issueWebhook('resolved'))
  check('sentry issue.resolved again (no change) → duplicate', uiResolveAgain.body?.status === 'duplicate', uiResolveAgain)
  const unknownResolved = await sendSentry('issue', {
    action: 'resolved',
    data: { issue: { ...sentryIssue.data.issue, id: String(Date.now() + 99), web_url: undefined } },
  })
  check('sentry issue.resolved for unknown issue → 202 ignored', unknownResolved.status === 202, unknownResolved)

  // Provider error path (dry-run fake: issue id 9999…409 → simulated 409).
  const failingIssue = `9999${Date.now()}409`
  const failingAlert = await sendSentry('issue', {
    action: 'created',
    data: {
      issue: {
        ...sentryIssue.data.issue,
        id: failingIssue,
        title: 'Simulated provider failure',
        web_url: `https://acme.sentry.io/issues/${failingIssue}/`,
      },
    },
  })
  const failIntent = await api('POST', '/api/actions/intent', {
    token,
    body: { alertId: failingAlert.body?.id, action: 'resolve' },
  })
  const failConfirm = await api('POST', '/api/actions/confirm', {
    token,
    body: { requestId: failIntent.body?.requestId, nonce: failIntent.body?.nonce },
  })
  check(
    'provider 409 → 200 failed with generic message, alert stays open',
    failingAlert.status === 201 &&
      failConfirm.status === 200 &&
      failConfirm.body.status === 'failed' &&
      failConfirm.body.providerStatus === 409 &&
      !/simulated/i.test(failConfirm.body.message) &&
      failConfirm.body.alertStatus === 'open',
    failConfirm,
  )

  // Audit (device sees only its own entries).
  const auditDev = await api('GET', '/api/audit?limit=200', { token })
  const devEntries = auditDev.body?.entries ?? []
  const events = new Set(devEntries.map((e) => e.event))
  const want = ['pair.approved', 'pair.claimed', 'action.intent', 'action.confirm', 'action.succeeded', 'action.failed', 'action.denied']
  check('audit (device) has pairing + action events', auditDev.status === 200 && want.every((e) => events.has(e)), {
    status: auditDev.status,
    missing: want.filter((e) => !events.has(e)),
  })
  const foreign = devEntries.filter((e) => e.actor !== `device:${deviceId}` && e.detail?.deviceId !== deviceId)
  check('audit (device) contains only its own entries', auditDev.status === 200 && devEntries.length > 0 && foreign.length === 0, {
    foreign: foreign.slice(0, 3).map((e) => e.event),
  })
  const failedEntry = devEntries.find((e) => e.event === 'action.failed')
  check(
    'audit keeps truncated provider detail',
    typeof failedEntry?.detail?.providerDetail === 'string' && failedEntry.detail.providerDetail.length <= 200,
    failedEntry?.detail,
  )
  const auditAdmin = await api('GET', '/api/audit?limit=5', { token: ADMIN })
  check('audit (admin secret) → 200', auditAdmin.status === 200 && auditAdmin.body.entries.length === 5, {
    status: auditAdmin.status,
  })
  const auditAnon = await api('GET', '/api/audit')
  check('audit without auth → 401', auditAnon.status === 401, auditAnon)

  // Rate limit (atomic): a second device fires 13 intents at once → exactly 10 accepted.
  const b = await pairDevice(ADMIN, 'selftest B')

  // Another device cannot confirm (or even see) device A's pending intent; A still can.
  const ownIntent = await api('POST', '/api/actions/intent', { token, body: { alertId: ghAlert, action: 'rerun' } })
  const ownBody = { requestId: ownIntent.body?.requestId, nonce: ownIntent.body?.nonce }
  const otherConfirm = await api('POST', '/api/actions/confirm', { token: b.token, body: ownBody })
  const ownConfirm = await api('POST', '/api/actions/confirm', { token, body: ownBody })
  check(
    "other device confirming A's intent → 404, A's own confirm → 200",
    ownIntent.status === 201 && otherConfirm.status === 404 && ownConfirm.status === 200,
    { intent: ownIntent.status, other: otherConfirm.status, own: ownConfirm.status },
  )
  const burst = await Promise.all(
    Array.from({ length: 13 }, () =>
      api('POST', '/api/actions/intent', { token: b.token, body: { alertId: ghAlert, action: 'rerun' } }),
    ),
  )
  const burstCodes = burst.map((r) => r.status)
  check(
    '13 parallel intents → exactly 10 × 201, 3 × 429',
    burstCodes.filter((s) => s === 201).length === 10 && burstCodes.filter((s) => s === 429).length === 3,
    burstCodes.sort(),
  )

  // Pair start limit (atomic, per IP): 7 parallel starts from one fresh IP → exactly 5 accepted.
  const pairIp = randomIp()
  const starts = await Promise.all(Array.from({ length: 7 }, () => api('POST', '/api/pair/start', { ip: pairIp })))
  const startCodes = starts.map((r) => r.status)
  check(
    '7 parallel pair starts from one IP → 5 × 201, 2 × 429',
    startCodes.filter((s) => s === 201).length === 5 && startCodes.filter((s) => s === 429).length === 2,
    startCodes.sort(),
  )

  // ADMIN_SECRET brute force: 5 failures from one IP lock that IP out, even for the right secret.
  const bruteIp = randomIp()
  const wrongs = []
  for (let i = 0; i < 5; i++) {
    wrongs.push((await api('GET', '/api/audit?limit=1', { token: `wrong-admin-${i}`, ip: bruteIp })).status)
  }
  const locked = await api('POST', '/api/admin/pair/approve', { token: ADMIN, body: { code: 'AAAAAA' }, ip: bruteIp })
  const otherIp = await api('GET', '/api/audit?limit=1', { token: ADMIN })
  check(
    'admin brute force: 5 × 401 then 429 for that IP; other IP still OK',
    wrongs.every((s) => s === 401) && locked.status === 429 && otherIp.status === 200,
    { wrongs, locked: locked.status, otherIp: otherIp.status },
  )

  // Revocation.
  const revoke = await api('POST', '/api/admin/devices/revoke', { token: ADMIN, body: { deviceId } })
  check('revoke device → 200', revoke.status === 200 && revoke.body.ok === true, revoke)
  const revokedRead = await api('GET', '/api/alerts', { token })
  check('revoked device reads alerts → 401', revokedRead.status === 401, revokedRead)
  const revokedWrite = await api('POST', '/api/actions/intent', { token, body: { alertId: ghAlert, action: 'rerun' } })
  check('revoked device intent → 401', revokedWrite.status === 401, revokedWrite)
}

process.exit(failed ? 1 : 0)
