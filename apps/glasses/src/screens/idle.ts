import type { Alert } from '@pagerline/shared'
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { HEADER_H, IDLE_BODY, MAX_TEXT_CHARS, SCREEN_H, SCREEN_W } from '../ids'
import { ago, clip, sevTag } from './format'
import { header, type Page } from './layout'

/** Idle: status header + the three most recent alerts. */
export function idleBody(alertsNewestFirst: Alert[]): string {
  const recent = alertsNewestFirst.slice(0, 3)
  const lines =
    recent.length === 0
      ? ['All quiet. No alerts yet.']
      : recent.map((a) => `${sevTag(a)}  ${ago(a.createdAt)}  ${clip(a.title, 44)}`)
  return [...lines, '', 'Tap: inbox  ·  Double-tap: exit  ·  Hold: re-pair'].join('\n').slice(0, MAX_TEXT_CHARS)
}

export function idlePage(headerContent: string, alertsNewestFirst: Alert[]): Page {
  return {
    textObject: [
      header(headerContent),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: HEADER_H + 4,
        width: SCREEN_W,
        height: SCREEN_H - HEADER_H - 4,
        borderWidth: 1,
        borderColor: 5,
        borderRadius: 6,
        paddingLength: 8,
        containerID: IDLE_BODY.id,
        containerName: IDLE_BODY.name,
        content: idleBody(alertsNewestFirst),
        isEventCapture: 1,
      }),
    ],
  }
}
