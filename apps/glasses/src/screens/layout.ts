import { ListContainerProperty, ListItemContainerProperty, TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { HEADER, HEADER_H, MAX_LIST_ITEM_CHARS, MAX_TEXT_CHARS, SCREEN_H, SCREEN_W } from '../ids'
import { clip } from './format'

/** A full page description; `render.ts` turns it into create/rebuild calls. */
export interface Page {
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
}

export interface ContainerRef {
  readonly id: number
  readonly name: string
}

/** Top of the content area, below the header. */
export const BODY_Y = HEADER_H + 4
/** Height of one list row as rendered by the firmware (inbox screenshots: ~40 px). */
export const LIST_ROW_H = 40

export function header(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_W,
    height: HEADER_H,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: HEADER.id,
    containerName: HEADER.name,
    content,
    isEventCapture: 0,
  })
}

/** Bordered text box; pass `capture` for the one container that should receive taps. */
export function textBox(
  ref: ContainerRef,
  content: string,
  opts: { y?: number; height?: number; capture?: boolean } = {},
): TextContainerProperty {
  const y = opts.y ?? BODY_Y
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: y,
    width: SCREEN_W,
    height: opts.height ?? SCREEN_H - y,
    borderWidth: 1,
    borderColor: 5,
    borderRadius: 6,
    paddingLength: 8,
    containerID: ref.id,
    containerName: ref.name,
    content: content.slice(0, MAX_TEXT_CHARS),
    isEventCapture: opts.capture === false ? 0 : 1,
  })
}

/** Bordered native list; the firmware always starts with row 0 selected. */
export function listBox(ref: ContainerRef, items: string[], opts: { y?: number; height?: number } = {}): ListContainerProperty {
  const y = opts.y ?? BODY_Y
  const names = items.map((i) => clip(i, MAX_LIST_ITEM_CHARS))
  return new ListContainerProperty({
    xPosition: 0,
    yPosition: y,
    width: SCREEN_W,
    height: opts.height ?? SCREEN_H - y,
    borderWidth: 1,
    borderColor: 5,
    borderRadius: 6,
    paddingLength: 4,
    containerID: ref.id,
    containerName: ref.name,
    itemContainer: new ListItemContainerProperty({
      itemCount: names.length,
      itemWidth: SCREEN_W - 16,
      isItemSelectBorderEn: 1,
      itemName: names,
    }),
    isEventCapture: 1,
  })
}
