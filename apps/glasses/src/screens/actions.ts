import type { ActionKind, ActionPreview, ActionConfirmResult, Alert } from '@pagerline/shared'
import { ACTIONS_LIST, CONFIRM_BODY, CONFIRM_LIST, RESULT_BODY, SCREEN_H } from '../ids'
import { clip } from './format'
import { BODY_Y, header, LIST_ROW_H, listBox, textBox, type Page } from './layout'

const LINE = 52

export const ACTION_LABEL: Record<ActionKind, string> = {
  rerun: 'Re-run failed jobs',
  resolve: 'Resolve Sentry issue',
}

// ---- actions list: row 0 = Back, rows 1..n = alert.actions ----------------

export const NO_ACTIONS_ITEM = 'No actions for this alert'

export function actionItems(kinds: ActionKind[]): string[] {
  return ['< Back', ...(kinds.length === 0 ? [NO_ACTIONS_ITEM] : kinds.map((k) => ACTION_LABEL[k]))]
}

export function actionsPage(headerContent: string, kinds: ActionKind[]): Page {
  const items = actionItems(kinds)
  // Size the box to its rows: the firmware centres a short list vertically in a tall box.
  const height = Math.min(SCREEN_H - BODY_Y, items.length * LIST_ROW_H + 12)
  return { textObject: [header(headerContent)], listObject: [listBox(ACTIONS_LIST, items, { height })] }
}

// ---- confirm: preview + [Cancel, Confirm]; row 0 (Cancel) is selected first --

/** Two rows plus the list's padding/border. */
const CONFIRM_LIST_H = LIST_ROW_H * 2 + 12
const CONFIRM_LIST_Y = SCREEN_H - CONFIRM_LIST_H

export const CONFIRM_ITEMS = ['Cancel', 'Confirm'] as const

export type ConfirmPhase = { kind: 'ready'; secondsLeft: number } | { kind: 'sending' } | { kind: 'expired' }

function statusLine(p: ActionPreview, phase: ConfirmPhase): string {
  const tag = `${p.action.toUpperCase()}${p.dryRun ? ' · DRY RUN' : ''}`
  if (phase.kind === 'sending') return `${tag} · Sending… please wait`
  if (phase.kind === 'expired') return `${tag} · EXPIRED, nothing was done`
  return `${tag} · ${phase.secondsLeft}s · scroll down to confirm`
}

export function confirmBody(p: ActionPreview, phase: ConfirmPhase): string {
  return [statusLine(p, phase), clip(p.headline, LINE), clip(p.target, LINE), clip(p.detail, LINE * 2)].join('\n')
}

export function confirmPage(headerContent: string, p: ActionPreview, phase: ConfirmPhase): Page {
  return {
    textObject: [
      header(headerContent),
      textBox(CONFIRM_BODY, confirmBody(p, phase), {
        y: BODY_Y,
        height: CONFIRM_LIST_Y - BODY_Y - 4,
        capture: false,
      }),
    ],
    listObject: [listBox(CONFIRM_LIST, [...CONFIRM_ITEMS], { y: CONFIRM_LIST_Y, height: CONFIRM_LIST_H })],
  }
}

// ---- unpair: same two-step layout, Cancel (row 0) selected first ------------

export function unpairBody(): string {
  return [
    'UNPAIR THIS G2 · scroll down to confirm',
    'Forgets the device token stored on these glasses.',
    'You will need a new pairing code and approval',
    'at <server>/pair before alerts show again.',
  ].join('\n')
}

export function unpairPage(headerContent: string): Page {
  return {
    textObject: [
      header(headerContent),
      textBox(CONFIRM_BODY, unpairBody(), { y: BODY_Y, height: CONFIRM_LIST_Y - BODY_Y - 4, capture: false }),
    ],
    listObject: [listBox(CONFIRM_LIST, [...CONFIRM_ITEMS], { y: CONFIRM_LIST_Y, height: CONFIRM_LIST_H })],
  }
}

// ---- result ----------------------------------------------------------------

export type ResultView =
  | { kind: 'done'; result: ActionConfirmResult; headline: string }
  | { kind: 'error'; title: string; message: string; headline: string }

export function resultBody(v: ResultView, alert: Alert | undefined): string {
  const lines: string[] = []
  if (v.kind === 'done') {
    const r = v.result
    lines.push(`${r.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED'}${r.dryRun ? ' · DRY RUN' : ''}`)
    // Server message is shown verbatim (failures carry a generic text); only length-limited.
    lines.push(clip(v.headline, LINE), clip(r.message, LINE * 3))
    const provider = r.providerStatus === null ? 'not called' : `HTTP ${r.providerStatus}`
    lines.push(`Provider: ${provider} · Alert now: ${r.alertStatus}`)
  } else {
    lines.push(clip(v.title, LINE), clip(v.headline, LINE), clip(v.message, LINE * 2))
  }
  if (alert) lines.push(clip(`Alert: ${alert.title}`, LINE))
  lines.push('', 'Tap: back to detail')
  return lines.join('\n')
}

export function resultPage(headerContent: string, v: ResultView, alert: Alert | undefined): Page {
  return { textObject: [header(headerContent), textBox(RESULT_BODY, resultBody(v, alert))] }
}
