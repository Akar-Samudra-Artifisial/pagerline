import type { Alert } from '@pagerline/shared'
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { fetchAlerts, isMock, setDeviceToken } from './api'
import { DETAIL_FOOTER, HEADER, IDLE_BODY } from './ids'
import { toGesture, type Gesture } from './input'
import { Renderer } from './render'
import { detailFooter, detailPage } from './screens/detail'
import { headerText } from './screens/format'
import { idleBody, idlePage } from './screens/idle'
import { inboxAlerts, inboxPage } from './screens/inbox'
import { loadDeviceToken } from './token'

const POLL_MS = 3000

type Screen = { name: 'idle' } | { name: 'inbox' } | { name: 'detail'; alertId: string; menuOpen: boolean }

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

function header(): string {
  const s = state.screen
  const pending = s.name === 'inbox' ? inboxAlerts(newestFirst()).filter((a) => !state.inboxIds.includes(a.id)).length : 0
  const titles = { idle: 'Idle', inbox: pending > 0 ? `Inbox +${pending} new` : 'Inbox', detail: 'Detail' } as const
  const openCount = [...state.alerts.values()].filter((a) => a.status === 'open').length
  return headerText({
    title: titles[s.name],
    openCount,
    online: state.online,
    mock: isMock(),
  })
}

function render(): Promise<void> {
  const s = state.screen
  if (s.name === 'idle') return renderer.show(idlePage(header(), newestFirst()))
  if (s.name === 'inbox') {
    const listed = inboxAlerts(newestFirst())
    state.inboxIds = listed.map((a) => a.id)
    return renderer.show(inboxPage(header(), listed))
  }
  const alert = state.alerts.get(s.alertId)
  if (!alert) {
    state.screen = { name: 'inbox' }
    return render()
  }
  return renderer.show(detailPage(header(), alert, s.menuOpen))
}

function go(screen: Screen): void {
  state.screen = screen
  render().catch((err: unknown) => console.error(err))
  mirror()
}

// ---- data -------------------------------------------------------------

let polling = false
async function poll(): Promise<void> {
  if (polling) return
  polling = true
  const before = state.alerts.size
  try {
    const { alerts, cursor } = await fetchAlerts(state.cursor)
    for (const a of alerts) state.alerts.set(a.id, a)
    state.cursor = cursor
    state.online = true
    state.error = null
  } catch (err) {
    state.online = false
    state.error = err instanceof Error ? err.message : String(err)
  } finally {
    polling = false
  }
  refresh(state.alerts.size !== before)
}

/** Update the visible screen after a poll without disturbing navigation. */
function refresh(changed: boolean): void {
  const s = state.screen
  // Idle is patched in place. The inbox list is not rebuilt (that would reset the
  // selected row); its header shows "+N new" instead — see state.inboxIds.
  const tasks: Promise<void>[] = [renderer.upgrade(HEADER, header())]
  if (changed && s.name === 'idle') tasks.push(renderer.upgrade(IDLE_BODY, idleBody(newestFirst())))
  Promise.all(tasks).catch((err: unknown) => console.error(err))
  mirror()
}

// ---- input ------------------------------------------------------------

function onGesture(g: Gesture): void {
  if (g.type === 'exit') {
    cleanup()
    return
  }
  if (g.type === 'foreground_enter') {
    startPolling()
    void poll()
    return
  }
  if (g.type === 'foreground_exit') {
    stopPolling()
    return
  }

  const s = state.screen
  if (s.name === 'idle') {
    if (g.type === 'click') go({ name: 'inbox' })
    else if (g.type === 'double_click' || g.type === 'long_press') void bridge.shutDownPageContainer(1)
    return
  }

  if (s.name === 'inbox') {
    if (g.type === 'click' && g.listIndex !== undefined) {
      // Map the row through the snapshot the list was built from, not the live data.
      const id = g.listIndex === 0 ? undefined : state.inboxIds[g.listIndex - 1]
      const alert = id === undefined ? undefined : state.alerts.get(id)
      go(alert ? { name: 'detail', alertId: alert.id, menuOpen: false } : { name: 'idle' })
    } else if (g.type === 'double_click') {
      go({ name: 'idle' })
    }
    // Scrolls move the native list selection; nothing to do here.
    return
  }

  // detail
  if (g.type === 'click' || g.type === 'scroll_up') {
    go({ name: 'inbox' })
  } else if (g.type === 'scroll_down') {
    const list = inboxSnapshot()
    const next = list[list.findIndex((a) => a.id === s.alertId) + 1]
    if (next) go({ name: 'detail', alertId: next.id, menuOpen: false })
  } else if (g.type === 'double_click') {
    // Action menu is a stub for now: toggle the footer hint.
    const menuOpen = !s.menuOpen
    state.screen = { ...s, menuOpen }
    renderer.upgrade(DETAIL_FOOTER, detailFooter(menuOpen)).catch((err: unknown) => console.error(err))
  } else if (g.type === 'long_press') {
    go({ name: 'idle' })
  }
}

let timer: ReturnType<typeof setInterval> | null = null
function startPolling(): void {
  if (timer === null) timer = setInterval(() => void poll(), POLL_MS)
}
function stopPolling(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

let cleanedUp = false
function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  stopPolling()
  unsubscribe()
}

// ---- companion mirror (phone WebView) ------------------------------------

const app = document.querySelector<HTMLDivElement>('#app')
function mirror(): void {
  if (!app) return
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

await render()
await poll()
startPolling()
