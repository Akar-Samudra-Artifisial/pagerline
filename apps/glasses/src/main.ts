import type { ActionKind, ActionPreview, Alert, VoiceIntent } from '@pagerline/shared'
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  ApiError,
  confirmAction,
  createIntent,
  fetchAlerts,
  fetchSummary,
  hasDeviceToken,
  isMock,
  pairingStatus,
  pairUrl,
  sendVoice,
  setDeviceToken,
  startPairing,
  type VoiceClip,
} from './api'
import { CONFIRM_BODY, DETAIL_BODY, HEADER, IDLE_BODY, PAIR_BODY, VOICE_BODY } from './ids'
import { toGesture, type Gesture } from './input'
import { feedPcm, startRecording, type Recording } from './recorder'
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
import { detailBody, detailPage, type SummaryView } from './screens/detail'
import { headerText } from './screens/format'
import { idleBody, idlePage } from './screens/idle'
import { inboxAlerts, inboxPage } from './screens/inbox'
import { pairBody, pairPage, type PairView } from './screens/pair'
import { voiceBody, voicePage, type VoiceMic, type VoiceView } from './screens/voice'
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
/** Voice command recording limit (server accepts ~8 s); a tap stops it sooner. */
const VOICE_MAX_MS = 6000
/** How long the transcript + intent stay on screen before the command runs. */
const VOICE_HEARD_MS = 2000
/** Voice error/notice screens return to Detail after this long. */
const VOICE_MESSAGE_MS = 2500
/** How long a failed summary refresh is flagged next to the kept text. */
const SUMMARY_NOTE_MS = 3000

type Screen =
  | { name: 'pair' }
  | { name: 'idle' }
  | { name: 'inbox' }
  | { name: 'detail'; alertId: string }
  | { name: 'actions'; alertId: string; kinds: ActionKind[] }
  | { name: 'confirm'; alertId: string; preview: ActionPreview; deadline: number; phase: 'ready' | 'sending' | 'expired' }
  | { name: 'result'; alertId: string; view: ResultView }
  | { name: 'unpair' }
  /** `token` identifies one voice attempt; async steps of an older attempt bail out. */
  | { name: 'voice'; alertId: string; token: number; view: VoiceView }

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
  /** AI summaries by alert id (the server caches them too). */
  summaries: new Map<string, SummaryView>(),
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
  voice: 'Voice',
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
    case 'voice':
      return renderer.show(voicePage(header(), s.view))
    case 'detail': {
      const alert = state.alerts.get(s.alertId)
      if (!alert) {
        state.screen = { name: 'inbox' }
        return render()
      }
      return renderer.show(detailPage(header(), alert, state.summaries.get(s.alertId)))
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
  // Leaving the voice screen always releases the microphone.
  if (screen.name !== 'voice') stopMic()
  state.screen = screen
  if (screen.name === 'detail') loadSummary(screen.alertId)
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
    if (a.id !== pinned) {
      state.alerts.delete(a.id)
      state.summaries.delete(a.id)
    }
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
    if (alert) tasks.push(renderer.upgrade(DETAIL_BODY, detailBody(alert, state.summaries.get(s.alertId))))
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
  stopMic()
  sessionGen++
  stopPolling()
  clearScreenTimer()
  setDeviceToken('')
  if (!isMock()) await clearDeviceToken(bridge)
  state.alerts.clear()
  state.summaries.clear()
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
  state.summaries.clear()
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

/**
 * Ask the server for a preview + nonce and show Confirm (Cancel focused).
 * `stillWanted` reports whether the screen that asked (actions list or a voice
 * command) is still showing; if not, the preview is dropped.
 * Resolves `false` only when nothing was started because another request is running.
 */
async function startIntent(alertId: string, action: ActionKind, stillWanted: () => boolean): Promise<boolean> {
  if (state.busy) return false
  state.busy = true
  renderer.upgrade(HEADER, header()).catch((err: unknown) => console.error(err))
  const gen = sessionGen
  try {
    const preview = await createIntent(alertId, action)
    if (gen !== sessionGen || !stillWanted()) return true // user navigated away meanwhile
    // Local deadline from the server's expiresAt, clamped to the documented TTL so a
    // skewed clock never shows more time than the nonce really has.
    const ttl = Date.parse(preview.expiresAt) - Date.now()
    const deadline = Date.now() + (ttl > 0 && ttl <= NONCE_TTL_MS ? ttl : NONCE_TTL_MS)
    go({ name: 'confirm', alertId, preview, deadline, phase: 'ready' })
    tickConfirm(preview.requestId)
  } catch (err) {
    if (gen !== sessionGen || !stillWanted()) return true
    handleActionError(err, alertId, ACTION_LABEL[action])
  } finally {
    state.busy = false
  }
  return true
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

// ---- AI summary (Detail) -------------------------------------------------------

/** Latest summary request per alert; an older response is dropped. */
const summaryReq = new Map<string, number>()
let summarySeq = 0

/** Load (or with `refresh`, regenerate) the summary; non-blocking, patches Detail when it lands. */
function loadSummary(alertId: string, refresh = false): void {
  const current = state.summaries.get(alertId)
  if (!refresh && current && current.kind !== 'error') return
  // A refresh keeps the old text on screen until the new one lands.
  const previous = current?.kind === 'ready' ? current : null
  state.summaries.set(alertId, previous ? { ...previous, note: 'refreshing…' } : { kind: 'loading' })
  updateDetailBody(alertId)
  const req = ++summarySeq
  summaryReq.set(alertId, req)
  const gen = sessionGen
  const stale = () => gen !== sessionGen || summaryReq.get(alertId) !== req
  fetchSummary(alertId, refresh).then(
    (res) => {
      if (stale()) return
      state.summaries.set(alertId, { kind: 'ready', text: res.summary, source: res.source })
      updateDetailBody(alertId)
    },
    (err: unknown) => {
      if (stale()) return
      if (err instanceof ApiError && err.status === 401 && !isMock()) {
        void unpair()
        return
      }
      const message = err instanceof ApiError && err.status === 429 ? 'rate limited' : errorText(err)
      if (!previous) {
        state.summaries.set(alertId, { kind: 'error', message })
        updateDetailBody(alertId)
        return
      }
      // Keep the text we already had; flag the failed refresh briefly.
      const kept: SummaryView = { ...previous, note: `refresh failed: ${message}` }
      state.summaries.set(alertId, kept)
      updateDetailBody(alertId)
      setTimeout(() => {
        if (stale() || state.summaries.get(alertId) !== kept) return
        state.summaries.set(alertId, previous)
        updateDetailBody(alertId)
      }, SUMMARY_NOTE_MS)
    },
  )
}

function updateDetailBody(alertId: string): void {
  const s = state.screen
  if (s.name !== 'detail' || s.alertId !== alertId) return
  const alert = state.alerts.get(alertId)
  if (alert) renderer.upgrade(DETAIL_BODY, detailBody(alert, state.summaries.get(alertId))).catch((err: unknown) => console.error(err))
}

// ---- voice commands --------------------------------------------------------------

let voiceSeq = 0
let mic: Recording | null = null

function stopMic(): void {
  mic?.cancel()
  mic = null
}

function currentVoice(token: number): Extract<Screen, { name: 'voice' }> | null {
  const s = state.screen
  return s.name === 'voice' && s.token === token ? s : null
}

function showVoice(s: Extract<Screen, { name: 'voice' }>, view: VoiceView): void {
  s.view = view
  renderer.upgrade(VOICE_BODY, voiceBody(view)).catch((err: unknown) => console.error(err))
  mirror()
}

/** Show a short notice, then return to the alert. */
function voiceNotice(token: number, title: string, detail?: string): void {
  const s = currentVoice(token)
  if (!s) return
  clearScreenTimer()
  stopMic()
  showVoice(s, { kind: 'message', title, detail })
  const { alertId } = s
  screenTimer = setTimeout(() => {
    if (currentVoice(token)) go({ name: 'detail', alertId })
  }, VOICE_MESSAGE_MS)
}

/** Long-press on Detail: record up to 6 s (tap stops), transcribe, then act on the intent. */
async function startVoice(alertId: string): Promise<void> {
  const token = ++voiceSeq
  go({ name: 'voice', alertId, token, view: { kind: 'starting' } })
  const gen = sessionGen
  let source: VoiceMic = 'mock'
  if (!isMock()) {
    try {
      const rec = await startRecording(bridge, () => currentVoice(token) !== null)
      if (gen !== sessionGen || !currentVoice(token)) {
        rec.cancel()
        return
      }
      mic = rec
      source = rec.source
    } catch (err) {
      voiceNotice(token, 'Microphone unavailable', errorText(err))
      return
    }
  }
  const s = currentVoice(token)
  if (!s) return
  const endsAt = Date.now() + VOICE_MAX_MS
  const tick = () => {
    const v = currentVoice(token)
    if (!v || v.view.kind !== 'listening') return
    const left = Math.ceil((endsAt - Date.now()) / 1000)
    if (left <= 0) {
      void finishVoice(token)
      return
    }
    if (left !== v.view.secondsLeft) showVoice(v, { kind: 'listening', source, secondsLeft: left })
    screenTimer = setTimeout(tick, ((endsAt - Date.now()) % 1000) || 1000)
  }
  showVoice(s, { kind: 'listening', source, secondsLeft: Math.ceil(VOICE_MAX_MS / 1000) })
  screenTimer = setTimeout(tick, 1000)
}

function voiceErrorTitle(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Voice failed'
  switch (err.status) {
    case 0:
      return 'Server unreachable'
    case 400:
    case 415:
      return 'Audio not accepted'
    case 404:
      return 'Alert not found'
    case 413:
      return 'Too long, keep it short'
    case 429:
      return 'Too many voice requests, try later'
    case 502:
      return 'Speech service failed'
    case 503:
      return 'Voice is not configured on the server'
    default:
      return `Voice failed (HTTP ${err.status})`
  }
}

/** Stop recording (tap or time limit), upload, show transcript + intent, then run it. */
async function finishVoice(token: number): Promise<void> {
  const s = currentVoice(token)
  if (!s || s.view.kind !== 'listening') return
  clearScreenTimer()
  const { alertId } = s
  const source = s.view.source
  showVoice(s, { kind: 'transcribing', source })
  const rec = mic
  mic = null
  // Mock mode has no microphone; the mock API scripts the "speech".
  const clip: VoiceClip | null = rec ? await rec.stop() : { data: new Blob([]), contentType: 'audio/pcm' }
  if (!currentVoice(token)) return
  if (!clip) {
    voiceNotice(token, 'No audio recorded', `mic: ${source}`)
    return
  }
  const gen = sessionGen
  try {
    const res = await sendVoice(clip, alertId)
    const v = currentVoice(token)
    if (gen !== sessionGen || !v) return
    showVoice(v, { kind: 'heard', source, transcript: res.transcript, intent: res.intent, next: intentNote(res.intent, alertId) })
    screenTimer = setTimeout(() => {
      if (currentVoice(token)) runIntent(token, res.intent)
    }, VOICE_HEARD_MS)
  } catch (err) {
    if (gen !== sessionGen || !currentVoice(token)) return
    if (err instanceof ApiError && err.status === 401 && !isMock()) {
      void unpair()
      return
    }
    voiceNotice(token, voiceErrorTitle(err), errorText(err))
  }
}

function canRun(alertId: string, action: ActionKind): boolean {
  return state.alerts.get(alertId)?.actions?.includes(action) ?? false
}

function nextAlertId(alertId: string): string | undefined {
  const list = inboxSnapshot()
  return list[list.findIndex((a) => a.id === alertId) + 1]?.id
}

/** What will happen, shown under the transcript. */
function intentNote(intent: VoiceIntent, alertId: string): string {
  switch (intent) {
    case 'rerun':
    case 'resolve':
      return canRun(alertId, intent) ? `→ ${ACTION_LABEL[intent]}: opening confirm…` : `→ ${ACTION_LABEL[intent]} is not available here`
    case 'next':
      return nextAlertId(alertId) ? '→ Next alert…' : '→ No next alert'
    case 'back':
      return '→ Back to idle…'
    case 'inbox':
      return '→ Opening inbox…'
    case 'summary':
      return '→ Refreshing summary…'
    case 'unknown':
      return "→ Didn't catch that. Back to the alert…"
  }
}

/**
 * Act on a recognised command. Write actions only open the Confirm screen
 * (Cancel focused); nothing spoken can confirm.
 */
function runIntent(token: number, intent: VoiceIntent): void {
  const s = currentVoice(token)
  if (!s) return
  const { alertId } = s
  switch (intent) {
    case 'rerun':
    case 'resolve':
      if (!canRun(alertId, intent)) {
        go({ name: 'detail', alertId })
        return
      }
      void startIntent(alertId, intent, () => currentVoice(token) !== null).then((started) => {
        // Another request was still running: never leave the voice screen stuck on "heard".
        if (!started) voiceNotice(token, 'Busy, try again', 'Another action is still running')
      })
      return
    case 'next':
      go({ name: 'detail', alertId: nextAlertId(alertId) ?? alertId })
      return
    case 'back':
      go({ name: 'idle' })
      return
    case 'inbox':
      go({ name: 'inbox' })
      return
    case 'summary':
      go({ name: 'detail', alertId })
      loadSummary(alertId, true)
      return
    case 'unknown':
      go({ name: 'detail', alertId })
      return
  }
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
    const v = state.screen
    if (v.name === 'voice') go({ name: 'detail', alertId: v.alertId }) // never record in the background
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
        void startVoice(s.alertId)
      }
      return

    case 'voice':
      if (g.type === 'double_click') {
        go({ name: 'detail', alertId: s.alertId }) // cancel: drops the recording
      } else if ((g.type === 'click' || g.type === 'long_press') && s.view.kind === 'listening') {
        void finishVoice(s.token)
      }
      return

    case 'actions': {
      if (state.busy) return
      if (g.type === 'double_click') {
        go({ name: 'detail', alertId: s.alertId })
      } else if (g.type === 'click' && g.listIndex !== undefined) {
        const kind = g.listIndex === 0 ? undefined : s.kinds[g.listIndex - 1]
        const { alertId } = s
        if (kind) {
          void startIntent(alertId, kind, () => {
            const cur = state.screen
            return cur.name === 'actions' && cur.alertId === alertId
          })
        } else go({ name: 'detail', alertId }) // Back, or the "No actions" row
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
  stopMic()
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
  if (state.screen.name === 'voice') {
    // Browser-mic fallback records on the phone: show progress there too.
    app.innerHTML = `<h1 style="font-size:18px;margin:0 0 8px">Pagerline · voice</h1>
      <pre style="white-space:pre-wrap;margin:0">${escapeHtml(voiceBody(state.screen.view))}</pre>`
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
  if (event.audioEvent) {
    feedPcm(event.audioEvent.audioPcm)
    return
  }
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
