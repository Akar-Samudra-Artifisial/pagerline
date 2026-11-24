import { PAIR_BODY } from '../ids'
import { clip } from './format'
import { header, textBox, type Page } from './layout'

export type PairView =
  | { phase: 'starting' }
  | { phase: 'pending'; code: string; url: string; expiresAt: string }
  | { phase: 'expired' }
  | { phase: 'error'; message: string; title?: string }

const LINE = 52

/** `ABC234` → `A  B  C  2  3  4`: the SDK has no font sizes, so spacing is the emphasis. */
function spaced(code: string): string {
  return code.split('').join('  ')
}

function minutesLeft(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return '0s'
  const sec = Math.max(0, Math.round(ms / 1000))
  return sec >= 60 ? `${Math.ceil(sec / 60)} min` : `${sec}s`
}

export function pairBody(v: PairView): string {
  switch (v.phase) {
    case 'starting':
      return ['Pair this G2 with Pagerline', '', 'Requesting a pairing code…'].join('\n')
    case 'pending':
      return [
        'Pair this G2 with Pagerline',
        '',
        `CODE     ${spaced(v.code)}`,
        '',
        clip(`Open ${v.url}`, LINE),
        'and enter the code to approve this device.',
        `Waiting for approval · expires in ${minutesLeft(v.expiresAt)}`,
        'Double-tap: exit',
      ].join('\n')
    case 'expired':
      return ['Pair this G2 with Pagerline', '', 'The pairing code expired.', '', 'Tap: get a new code', 'Double-tap: exit'].join('\n')
    case 'error':
      return [
        'Pair this G2 with Pagerline',
        '',
        clip(v.title ?? 'Could not get a pairing code:', LINE),
        clip(v.message, LINE),
        '',
        'Tap: try again',
        'Double-tap: exit',
      ].join('\n')
  }
}

export function pairPage(headerContent: string, v: PairView): Page {
  return { textObject: [header(headerContent), textBox(PAIR_BODY, pairBody(v))] }
}
