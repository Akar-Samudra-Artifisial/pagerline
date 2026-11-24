import type { Alert } from '@pagerline/shared'
import { TIER1_ACTIONS, TIER2_ACTIONS } from '@pagerline/shared'
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { DETAIL_BODY, DETAIL_FOOTER, FOOTER_H, HEADER_H, MAX_TEXT_CHARS, SCREEN_H, SCREEN_W } from '../ids'
import { ago, sevTag } from './format'
import { header, type Page } from './layout'

export function detailBody(a: Alert): string {
  const lines = [`${sevTag(a)} · ${a.source} · ${a.status} · ${ago(a.createdAt)} ago`, a.title, '', a.summary]
  if (a.scope) lines.push('', `Scope: ${a.scope}`)
  // Keep line breaks; only enforce the firmware's per-container character limit.
  const text = lines.join('\n')
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS - 1)}…`
}

export function detailFooter(menuOpen: boolean): string {
  return menuOpen
    ? `Actions (soon): ${TIER1_ACTIONS.join(' ')} | ${TIER2_ACTIONS.join(' ')}`
    : 'Tap/swipe up: back · Swipe down: next · Double-tap: actions'
}

export function detailPage(headerContent: string, alert: Alert, menuOpen: boolean): Page {
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
        content: detailBody(alert),
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
        content: detailFooter(menuOpen),
        isEventCapture: 0,
      }),
    ],
  }
}
