import type { Alert } from '@pagerline/shared'
import { ListContainerProperty, ListItemContainerProperty } from '@evenrealities/even_hub_sdk'
import { HEADER_H, INBOX_LIST, MAX_LIST_ITEM_CHARS, MAX_LIST_ITEMS, SCREEN_H, SCREEN_W } from '../ids'
import { ago, clip, sevTag } from './format'
import { header, type Page } from './layout'

export const BACK_ITEM = '< Back'

/** Alerts shown in the list (item 0 is always "Back"). */
export function inboxAlerts(alertsNewestFirst: Alert[]): Alert[] {
  return alertsNewestFirst.slice(0, MAX_LIST_ITEMS - 1)
}

function itemLabel(a: Alert): string {
  return clip(`${sevTag(a)} ${ago(a.createdAt)} ${a.title}`, MAX_LIST_ITEM_CHARS)
}

export function inboxPage(headerContent: string, alertsNewestFirst: Alert[]): Page {
  const items = [BACK_ITEM, ...inboxAlerts(alertsNewestFirst).map(itemLabel)]
  return {
    textObject: [header(headerContent)],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: HEADER_H + 4,
        width: SCREEN_W,
        height: SCREEN_H - HEADER_H - 4,
        borderWidth: 1,
        borderColor: 5,
        borderRadius: 6,
        paddingLength: 4,
        containerID: INBOX_LIST.id,
        containerName: INBOX_LIST.name,
        itemContainer: new ListItemContainerProperty({
          itemCount: items.length,
          itemWidth: SCREEN_W - 16,
          isItemSelectBorderEn: 1,
          itemName: items,
        }),
        isEventCapture: 1,
      }),
    ],
  }
}
