import type { Alert, SummarySource } from '@pagerline/shared'
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { DETAIL_BODY, DETAIL_FOOTER, FOOTER_H, HEADER_H, MAX_TEXT_CHARS, SCREEN_H, SCREEN_W } from '../ids'
import { ago, clip, sevTag } from './format'
import { header, type Page } from './layout'

/** AI summary of the alert on screen, loaded separately from the alert itself. */
export type SummaryView =
  | { kind: 'loading' }
  /** `note`: short status next to an existing text, e.g. "refreshing…" or a failed refresh. */
  | { kind: 'ready'; text: string; source: SummarySource; note?: string }
  | { kind: 'error'; message: string }

const SOURCE_LABEL: Record<SummarySource, string> = { ai: 'AI', cache: 'cached', fallback: 'fallback' }

function summaryLines(s: SummaryView | undefined): string[] {
  if (!s || s.kind === 'loading') return ['Summary: Summarizing…']
  if (s.kind === 'error') return [`Summary unavailable (${clip(s.message, 60)})`]
  const note = s.note ? ` · ${clip(s.note, 40)}` : ''
  return [`Summary [${SOURCE_LABEL[s.source]}]${note}:`, clip(s.text, 240)]
}

export function detailBody(a: Alert, summary?: SummaryView): string {
  const lines = [`${sevTag(a)} · ${a.source} · ${a.status} · ${ago(a.createdAt)} ago`, a.title, '', ...summaryLines(summary), '', a.summary]
  if (a.scope) lines.push('', `Scope: ${a.scope}`)
  // Keep line breaks; only enforce the firmware's per-container character limit.
  const text = lines.join('\n')
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS - 1)}…`
}

export function detailFooter(): string {
  return 'Tap/up: back · Down: next · 2×tap: actions · Hold: voice'
}

export function detailPage(headerContent: string, alert: Alert, summary?: SummaryView): Page {
  const bodyH = SCREEN_H - HEADER_H - FOOTER_H - 8
  return {
    textObject: [
      header(headerContent),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: HEADER_H + 4,
        width: SCREEN_W,
        height: bodyH,
        borderWidth: 1,
        borderColor: 5,
        borderRadius: 6,
        paddingLength: 8,
        containerID: DETAIL_BODY.id,
        containerName: DETAIL_BODY.name,
        content: detailBody(alert, summary),
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: SCREEN_H - FOOTER_H,
        width: SCREEN_W,
        height: FOOTER_H,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: DETAIL_FOOTER.id,
        containerName: DETAIL_FOOTER.name,
        content: detailFooter(),
        isEventCapture: 0,
      }),
    ],
  }
}
