import { ListContainerProperty, TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { HEADER, HEADER_H, SCREEN_W } from '../ids'

/** A full page description; `render.ts` turns it into create/rebuild calls. */
export interface Page {
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
}

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
