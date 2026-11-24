import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type Gesture =
  | { type: 'click'; listIndex?: number }
  | { type: 'double_click' }
  | { type: 'scroll_up' }
  | { type: 'scroll_down' }
  | { type: 'long_press' }
  | { type: 'foreground_enter' }
  | { type: 'foreground_exit' }
  | { type: 'exit' }

// CLICK_EVENT is 0 and protobuf drops zero values, so a tap arrives with
// `eventType` undefined. Default to CLICK only when the envelope exists.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

/**
 * Collapse one bridge event into a gesture. Explicit non-zero types
 * (double-click, scrolls, long-press, lifecycle) are matched before CLICK.
 */
export function toGesture(event: EvenHubEvent): Gesture | null {
  if (event.audioEvent) return null
  const types = [eventTypeOf(event.sysEvent), eventTypeOf(event.textEvent), eventTypeOf(event.listEvent)]
  const has = (t: OsEventTypeList) => types.includes(t)

  if (has(OsEventTypeList.SYSTEM_EXIT_EVENT) || has(OsEventTypeList.ABNORMAL_EXIT_EVENT)) return { type: 'exit' }
  if (has(OsEventTypeList.FOREGROUND_ENTER_EVENT)) return { type: 'foreground_enter' }
  if (has(OsEventTypeList.FOREGROUND_EXIT_EVENT)) return { type: 'foreground_exit' }
  if (has(OsEventTypeList.DOUBLE_CLICK_EVENT)) return { type: 'double_click' }
  if (has(OsEventTypeList.LONG_PRESS_EVENT)) return { type: 'long_press' }
  if (has(OsEventTypeList.SCROLL_TOP_EVENT)) return { type: 'scroll_up' }
  if (has(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return { type: 'scroll_down' }
  if (has(OsEventTypeList.CLICK_EVENT)) {
    // currentSelectItemIndex is omitted on the wire when it is 0.
    return event.listEvent
      ? { type: 'click', listIndex: event.listEvent.currentSelectItemIndex ?? 0 }
      : { type: 'click' }
  }
  return null
}
