import type { ActionKind, ActionPreview, Alert } from '@pagerline/shared'
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  ApiError,
  confirmAction,
  createIntent,
  fetchAlerts,
  hasDeviceToken,
  isMock,
  pairingStatus,
  pairUrl,
  setDeviceToken,
  startPairing,
} from './api'
import { CONFIRM_BODY, DETAIL_BODY, HEADER, IDLE_BODY, PAIR_BODY } from './ids'
import { toGesture, type Gesture } from './input'
import { Renderer } from './render'
import {
  ACTION_LABEL,
  actionsPage,
  confirmBody,
  confirmPage,
  resultPage,
  unpairPage,
  type ConfirmPhase,
  type ResultView,
} from './screens/actions'
import { detailBody, detailPage } from './screens/detail'
import { headerText } from './screens/format'
import { idleBody, idlePage } from './screens/idle'
import { inboxAlerts, inboxPage } from './screens/inbox'
import { pairBody, pairPage, type PairView } from './screens/pair'
import { clearDeviceToken, loadDeviceToken, saveDeviceToken } from './token'

const POLL_MS = 3000
/** How long "expired" stays on the confirm screen before returning to the action list. */
const EXPIRED_NOTICE_MS = 2500
/** Result screen returns to Detail on its own after this long (tap returns sooner). */
const RESULT_AUTO_BACK_MS = 15_000
/** Nonce TTL the server documents; used when the client clock disagrees with `expiresAt`. */
const NONCE_TTL_MS = 60_000
/** The unpair prompt falls back to Idle if left untouched this long. */
const UNPAIR_PROMPT_MS = 30_000
/** Keep at most this many alerts in memory (newest by seq, plus the one on screen). */
const MAX_ALERTS = 200

type Screen =
  | { name: 'pair' }
  | { name: 'idle' }
  | { name: 'inbox' }
  | { name: 'detail'; alertId: string }
  | { name: 'actions'; alertId: string; kinds: ActionKind[] }
  | { name: 'confirm'; alertId: string; preview: ActionPreview; deadline: number; phase: 'ready' | 'sending' | 'expired' }
  | { name: 'result'; alertId: string; view: ResultView }
  | { name: 'unpair' }

const state = {
  screen: { name: 'idle' } as Screen,
  alerts: new Map<string, Alert>(),
  cursor: null as number | null,
  online: false,
  error: null as string | null,
  /**
   * Alert ids in the order the inbox list was last built (row i+1 → inboxIds[i]).
   * The SDK cannot set a list's selected row, so rebuilding would jump the
   * selection back to row 0; instead the list stays frozen while it is on screen
   * and new alerts are announced in the header until the inbox is re-entered.
   */
  inboxIds: [] as string[],
  /** An intent request is in flight (actions screen ignores input meanwhile). */
  busy: false,
  pair: { phase: 'starting' } as PairView,
}

const bridge = await waitForEvenAppBridge()
const renderer = new Renderer(bridge)
setDeviceToken(await loadDeviceToken(bridge))

function newestFirst(): Alert[] {
  return [...state.alerts.values()].sort((a, b) => b.seq - a.seq)
}

/** Alerts currently listed in the inbox, in on-screen order. */
function inboxSnapshot(): Alert[] {
  return state.inboxIds.map((id) => state.alerts.get(id)).filter((a): a is Alert => a !== undefined)
}

const TITLES: Record<Screen['name'], string> = {
  pair: 'Pair',
  idle: 'Idle',
  inbox: 'Inbox',
  detail: 'Detail',
  actions: 'Actions',
  confirm: 'Confirm',
  result: 'Result',
  unpair: 'Unpair?',
}

function header(): string {
  const s = state.screen
  let title = TITLES[s.name]
  if (s.name === 'inbox') {
    const pending = inboxAlerts(newestFirst()).filter((a) => !state.inboxIds.includes(a.id)).length
    if (pending > 0) title = `Inbox +${pending} new`
  } else if (s.name === 'actions' && state.busy) {
    title = 'Actions · preparing…'
  }
  const openCount = [...state.alerts.values()].filter((a) => a.status === 'open').length
  return headerText({ title, openCount, online: state.online, mock: isMock() })
}

function confirmPhase(s: Extract<Screen, { name: 'confirm' }>): ConfirmPhase {
  if (s.phase !== 'ready') return { kind: s.phase }
  return { kind: 'ready', secondsLeft: Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000)) }
}

function render(): Promise<void> {
  const s = state.screen
  switch (s.name) {
    case 'pair':
      return renderer.show(pairPage(header(), state.pair))
    case 'idle':
      return renderer.show(idlePage(header(), newestFirst()))
    case 'inbox': {
      const listed = inboxAlerts(newestFirst())
      state.inboxIds = listed.map((a) => a.id)
      return renderer.show(inboxPage(header(), listed))
    }
    case 'actions':
      return renderer.show(actionsPage(header(), s.kinds))
    case 'confirm':
      return renderer.show(confirmPage(header(), s.preview, confirmPhase(s)))
    case 'result':
      return renderer.show(resultPage(header(), s.view, state.alerts.get(s.alertId)))
    case 'unpair':
      return renderer.show(unpairPage(header()))
    case 'detail': {
      const alert = state.alerts.get(s.alertId)
      if (!alert) {
        state.screen = { name: 'inbox' }
        return render()
      }
      return renderer.show(detailPage(header(), alert))
    }
  }
}

/** Timer owned by the current screen (confirm countdown, result auto-back); cleared on navigation. */
let screenTimer: ReturnType<typeof setTimeout> | null = null
function clearScreenTimer(): void {
  if (screenTimer !== null) clearTimeout(screenTimer)
  screenTimer = null
}

function go(screen: Screen): void {
  clearScreenTimer()
  state.screen = screen
  render().catch((err: unknown) => console.error(err))
  mirror()
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- alerts polling --------------------------------------------------------

/**
 * Bumped on unpair and on a fresh pairing. Any request started under an older
 * session (alerts poll, intent, confirm) drops its result instead of writing
 * into the new session's state.
 */
let sessionGen = 0

let polling = false
async function poll(): Promise<void> {
  if (polling || state.screen.name === 'pair') return
  polling = true
  const gen = sessionGen
  const updated = new Set<string>()
  try {
    const { alerts, cursor } = await fetchAlerts(state.cursor)
    if (gen !== sessionGen) return // unpaired/re-paired meanwhile: stale data
    // Upsert by id: an alert re-appears with a higher seq when its status changes
    // (resolved, reopened); it replaces the old copy instead of being appended.
    for (const a of alerts) {
      state.alerts.set(a.id, a)
      updated.add(a.id)
    }
    state.cursor = Math.max(state.cursor ?? 0, cursor)
    state.online = true
    state.error = null
    trimAlerts()
  } catch (err) {
    if (gen !== sessionGen) return
    state.online = false
    state.error = errorText(err)
    if (err instanceof ApiError && err.status === 401 && !isMock()) {
      // Token revoked or unknown: forget it and pair again.
      void unpair()
      return
    }
  } finally {
    polling = false
  }
  refresh(updated)
}

/** Keep memory bounded: newest MAX_ALERTS by seq, never dropping the alert on screen. */
function trimAlerts(): void {
  if (state.alerts.size <= MAX_ALERTS) return
  const s = state.screen
  const pinned = 'alertId' in s ? s.alertId : undefined
  for (const a of newestFirst().slice(MAX_ALERTS)) {
    if (a.id !== pinned) state.alerts.delete(a.id)
  }
}

/** Update the visible screen after a poll without disturbing navigation. */
function refresh(updated: ReadonlySet<string>): void {
  const s = state.screen
  if (s.name === 'pair') return
  // Idle and an open Detail are patched in place. Lists are never rebuilt (that
  // would reset the selected row); the inbox header shows "+N new" instead.
  const tasks: Promise<void>[] = [renderer.upgrade(HEADER, header())]
  if (updated.size > 0 && s.name === 'idle') tasks.push(renderer.upgrade(IDLE_BODY, idleBody(newestFirst())))
  if (s.name === 'detail' && updated.has(s.alertId)) {
    const alert = state.alerts.get(s.alertId)
    if (alert) tasks.push(renderer.upgrade(DETAIL_BODY, detailBody(alert)))
  }
  Promise.all(tasks).catch((err: unknown) => console.error(err))
  mirror()
}

let timer: ReturnType<typeof setInterval> | null = null
function startPolling(): void {
  if (timer === null) timer = setInterval(() => void poll(), POLL_MS)
}
function stopPolling(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

// ---- pairing -----------------------------------------------------------------

/** Bumped whenever a pairing attempt is superseded; stale callbacks check it and bail. */
let pairGen = 0
let pairTimer: ReturnType<typeof setTimeout> | null = null
function stopPairPolling(): void {
  pairGen++
  if (pairTimer !== null) clearTimeout(pairTimer)
  pairTimer = null
}

function showPair(view: PairView): void {
  const wasPair = state.screen.name === 'pair'
  const sameLayout = wasPair && state.pair.phase === view.phase
  state.pair = view
  if (sameLayout) {
    renderer.upgrade(PAIR_BODY, pairBody(view)).catch((err: unknown) => console.error(err))
    mirror()
  } else {
    go({ name: 'pair' })
  }
}

async function unpair(): Promise<void> {
  sessionGen++
  stopPolling()
  clearScreenTimer()
  setDeviceToken('')
  if (!isMock()) await clearDeviceToken(bridge)
  state.alerts.clear()
  state.cursor = null
  state.inboxIds = []
  state.online = false
  state.busy = false
  void requestPairCode()
}

async function requestPairCode(): Promise<void> {
  stopPairPolling()
  const gen = pairGen
  showPair({ phase: 'starting' })
  try {
    const start = await startPairing()
    if (gen !== pairGen) return
    state.online = true
    showPair({ phase: 'pending', code: start.code, url: pairUrl(), expiresAt: start.expiresAt })
    schedulePairPoll(gen, start.pollSecret, Math.max(1000, start.pollIntervalMs), start.expiresAt)
  } catch (err) {
    if (gen !== pairGen) return
    state.online = false
    showPair({ phase: 'error', message: errorText(err) })
  }
}

function schedulePairPoll(gen: number, pollSecret: string, intervalMs: number, expiresAt: string): void {
  pairTimer = setTimeout(() => {
    void (async () => {
      if (gen !== pairGen) return
      try {
        const status = await pairingStatus(pollSecret)
        if (gen !== pairGen) return
        if (status.status === 'approved') {
          await onPaired(status.token)
          return
        }
        if (status.status === 'expired' || status.status === 'claimed') {
          // `claimed` means the one-time token went to an earlier poll we lost: start over.
          showPair({ phase: 'expired' })
          return
        }
      } catch (err) {
        if (gen !== pairGen) return
        if (err instanceof ApiError && err.status === 401) {
          showPair({ phase: 'expired' })
          return
        }
        // Network blip: keep polling until the code expires.
      }
      const expiry = Date.parse(expiresAt)
      if (Number.isNaN(expiry) || expiry <= Date.now()) {
        showPair({ phase: 'expired' })
        return
      }
      showPair(state.pair) // refresh the "expires in" line in place
      schedulePairPoll(gen, pollSecret, intervalMs, expiresAt)
    })()
  }, intervalMs)
}

async function onPaired(token: string): Promise<void> {
  stopPairPolling()
  // Mock pairing is replayed on every mock launch; never persist its fake token.
  if (!isMock()) {
    try {
      await saveDeviceToken(bridge, token)
    } catch (err) {
      // The one-time token is lost if it cannot be stored: ask for a new code.
      state.online = true
      showPair({ phase: 'error', message: `Could not save pairing (${errorText(err)}). Tap for new code.` })
      return
    }
  }
  sessionGen++
  state.alerts.clear()
  state.cursor = null
  state.inboxIds = []
  setDeviceToken(token)
  go({ name: 'idle' })
  await poll()
  startPolling()
}

// ---- write actions -------------------------------------------------------------

function actionErrorTitle(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Error'
  switch (err.status) {
    case 0:
      return 'Server unreachable'
    case 403:
      return 'Not allowed'
    case 404:
      return 'Not found'
    case 409:
      return 'Already handled'
    case 422:
      return 'Not possible for this alert'
    case 429:
      return 'Too many requests, try later'
    default:
      return `Error (HTTP ${err.status})`
  }
}

/** Shared error path for intent/confirm: 401 → re-pair, anything else → result screen. */
function handleActionError(err: unknown, alertId: string, headline: string): void {
  if (err instanceof ApiError && err.status === 401 && !isMock()) {
    void unpair()
    return
  }
  go({ name: 'result', alertId, view: { kind: 'error', title: actionErrorTitle(err), message: errorText(err), headline } })
  scheduleResultBack(alertId)
}

async function startIntent(alertId: string, action: ActionKind): Promise<void> {
  if (state.busy) return
  state.busy = true
  renderer.upgrade(HEADER, header()).catch((err: unknown) => console.error(err))
  try {
    const preview = await createIntent(alertId, action)
    const s = state.screen
    if (s.name !== 'actions' || s.alertId !== alertId) return // user navigated away meanwhile
    // Local deadline from the server's expiresAt, clamped to the documented TTL so a
    // skewed clock never shows more time than the nonce really has.
    const ttl = Date.parse(preview.expiresAt) - Date.now()
    const deadline = Date.now() + (ttl > 0 && ttl <= NONCE_TTL_MS ? ttl : NONCE_TTL_MS)
    go({ name: 'confirm', alertId, preview, deadline, phase: 'ready' })
    tickConfirm(preview.requestId)
  } catch (err) {
    handleActionError(err, alertId, ACTION_LABEL[action])
  } finally {
    state.busy = false
  }
}

function currentConfirm(requestId: string): Extract<Screen, { name: 'confirm' }> | null {
  const s = state.screen
  return s.name === 'confirm' && s.preview.requestId === requestId ? s : null
}

function updateConfirmBody(s: Extract<Screen, { name: 'confirm' }>): void {
  renderer.upgrade(CONFIRM_BODY, confirmBody(s.preview, confirmPhase(s))).catch((err: unknown) => console.error(err))
}

/** Countdown: re-render the status line every second until the nonce expires. */
function tickConfirm(requestId: string): void {
  const s = currentConfirm(requestId)
  if (!s || s.phase !== 'ready') return
  // Expire one second early so a tap at "0s" never races the server's TTL.
  if (s.deadline - Date.now() <= 1000) {
    expireConfirm(s)
    return
  }
  updateConfirmBody(s)
  const msToNextSecond = ((s.deadline - Date.now()) % 1000) || 1000
  screenTimer = setTimeout(() => tickConfirm(requestId), msToNextSecond)
}

function expireConfirm(s: Extract<Screen, { name: 'confirm' }>): void {
  clearScreenTimer()
  s.phase = 'expired'
  updateConfirmBody(s)
  const { alertId, preview } = s
  screenTimer = setTimeout(() => {
    if (currentConfirm(preview.requestId)) backToActions(alertId)
  }, EXPIRED_NOTICE_MS)
}

function backToActions(alertId: string): void {
  const alert = state.alerts.get(alertId)
  go(alert ? { name: 'actions', alertId, kinds: alert.actions ?? [] } : { name: 'inbox' })
}

async function sendConfirm(s: Extract<Screen, { name: 'confirm' }>): Promise<void> {
  // Lock first: further taps are ignored until the request settles.
  if (s.phase !== 'ready') return
  if (s.deadline - Date.now() <= 1000) {
    expireConfirm(s)
    return
  }
  clearScreenTimer()
  s.phase = 'sending'
  updateConfirmBody(s)
  const { alertId, preview } = s
  const gen = sessionGen
  try {
    const result = await confirmAction(preview.requestId, preview.nonce)
    // Unpaired (or navigated away) while the request ran: drop the outcome.
    if (gen !== sessionGen || !currentConfirm(preview.requestId)) return
    const alert = state.alerts.get(alertId)
    if (alert) state.alerts.set(alertId, { ...alert, status: result.alertStatus })
    go({ name: 'result', alertId, view: { kind: 'done', result, headline: preview.headline } })
    scheduleResultBack(alertId)
  } catch (err) {
    if (gen !== sessionGen || !currentConfirm(preview.requestId)) return
    if (err instanceof ApiError && err.status === 410) {
      const still = currentConfirm(preview.requestId)
      if (still) {
        still.phase = 'ready' // let expireConfirm show the notice and return
        expireConfirm(still)
      }
      return
    }
    handleActionError(err, alertId, preview.headline)
  }
}

function scheduleResultBack(alertId: string): void {
  screenTimer = setTimeout(() => {
    const s = state.screen
    if (s.name === 'result' && s.alertId === alertId) go({ name: 'detail', alertId })
  }, RESULT_AUTO_BACK_MS)
}

// ---- input ------------------------------------------------------------

function onGesture(g: Gesture): void {
  if (g.type === 'exit') {
    cleanup()
    return
  }
  if (g.type === 'foreground_enter') {
    if (state.screen.name !== 'pair') {
      startPolling()
      void poll()
    }
    return
  }
  if (g.type === 'foreground_exit') {
    stopPolling()
    return
  }

  const s = state.screen
  switch (s.name) {
    case 'pair':
      if (g.type === 'double_click') void bridge.shutDownPageContainer(1)
      else if (g.type === 'click' && (state.pair.phase === 'expired' || state.pair.phase === 'error')) void requestPairCode()
      return

    case 'idle':
      if (g.type === 'click') go({ name: 'inbox' })
      else if (g.type === 'double_click') void bridge.shutDownPageContainer(1)
      else if (g.type === 'long_press') {
        go({ name: 'unpair' })
        screenTimer = setTimeout(() => {
          if (state.screen.name === 'unpair') go({ name: 'idle' })
        }, UNPAIR_PROMPT_MS)
      }
      return

    case 'unpair':
      // Row 0 = Cancel (focused by default), row 1 = Confirm.
      if (g.type === 'click' && g.listIndex === 1) void unpair()
      else if ((g.type === 'click' && g.listIndex === 0) || g.type === 'double_click') go({ name: 'idle' })
      return

    case 'inbox':
      if (g.type === 'click' && g.listIndex !== undefined) {
        // Map the row through the snapshot the list was built from, not the live data.
        const id = g.listIndex === 0 ? undefined : state.inboxIds[g.listIndex - 1]
        const alert = id === undefined ? undefined : state.alerts.get(id)
        go(alert ? { name: 'detail', alertId: alert.id } : { name: 'idle' })
      } else if (g.type === 'double_click') {
        go({ name: 'idle' })
      }
      // Scrolls move the native list selection; nothing to do here.
      return

    case 'detail':
      if (g.type === 'click' || g.type === 'scroll_up') {
        go({ name: 'inbox' })
      } else if (g.type === 'scroll_down') {
        const list = inboxSnapshot()
        const next = list[list.findIndex((a) => a.id === s.alertId) + 1]
        if (next) go({ name: 'detail', alertId: next.id })
      } else if (g.type === 'double_click') {
        backToActions(s.alertId)
      } else if (g.type === 'long_press') {
        go({ name: 'idle' })
      }
      return

    case 'actions': {
      if (state.busy) return
      if (g.type === 'double_click') {
        go({ name: 'detail', alertId: s.alertId })
      } else if (g.type === 'click' && g.listIndex !== undefined) {
        const kind = g.listIndex === 0 ? undefined : s.kinds[g.listIndex - 1]
        if (kind) void startIntent(s.alertId, kind)
        else go({ name: 'detail', alertId: s.alertId }) // Back, or the "No actions" row
      }
      return
    }

    case 'confirm':
      if (s.phase === 'sending') return // locked while the confirm request runs
      if (s.phase === 'expired') return // notice is showing; it returns on its own
      if (g.type === 'click' && g.listIndex === 1) void sendConfirm(s)
      else if ((g.type === 'click' && g.listIndex === 0) || g.type === 'double_click') backToActions(s.alertId)
      // Scrolls move the native selection between Cancel and Confirm.
      return

    case 'result':
      if (g.type === 'click' || g.type === 'double_click') go({ name: 'detail', alertId: s.alertId })
      return
  }
}

let cleanedUp = false
function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  stopPolling()
  stopPairPolling()
  clearScreenTimer()
  unsubscribe()
}

// ---- companion mirror (phone WebView) ------------------------------------

const app = document.querySelector<HTMLDivElement>('#app')
function mirror(): void {
  if (!app) return
  if (state.screen.name === 'pair') {
    const p = state.pair
    app.innerHTML = `<h1 style="font-size:18px;margin:0 0 8px">Pagerline · pair</h1>
      <p style="margin:0 0 12px">${
        p.phase === 'pending'
          ? `Code <b style="font-size:22px;letter-spacing:4px">${escapeHtml(p.code)}</b> — approve at ${escapeHtml(p.url)}`
          : escapeHtml(pairBody(p).split('\n')[2] ?? '')
      }</p>`
    return
  }
  const rows = newestFirst()
    .slice(0, 10)
    .map((a) => `<li>[${a.severity}] ${escapeHtml(a.title)}</li>`)
    .join('')
  app.innerHTML = `<h1 style="font-size:18px;margin:0 0 8px">Pagerline</h1>
    <p style="color:#919191;margin:0 0 12px">${escapeHtml(header())}${state.error ? ` — ${escapeHtml(state.error)}` : ''}</p>
    <ul style="padding-left:18px;margin:0">${rows || '<li>No alerts</li>'}</ul>`
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

// ---- boot ---------------------------------------------------------------

const unsubscribe = bridge.onEvenHubEvent((event) => {
  const g = toGesture(event)
  if (g) onGesture(g)
})
window.addEventListener('beforeunload', cleanup)

if (hasDeviceToken()) {
  await render()
  await poll()
  startPolling()
} else {
  await requestPairCode()
}
