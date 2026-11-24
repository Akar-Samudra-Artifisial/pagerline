// Container IDs and names shared by every screen. `textContainerUpgrade` is a
// silent no-op unless BOTH id and name match the live container exactly.

export const SCREEN_W = 576
export const SCREEN_H = 288

export const HEADER = { id: 1, name: 'hdr' } as const
export const IDLE_BODY = { id: 2, name: 'idle' } as const
export const INBOX_LIST = { id: 3, name: 'inbox' } as const
export const DETAIL_BODY = { id: 4, name: 'body' } as const
export const DETAIL_FOOTER = { id: 5, name: 'ftr' } as const
export const PAIR_BODY = { id: 6, name: 'pair' } as const
export const ACTIONS_LIST = { id: 7, name: 'acts' } as const
export const CONFIRM_BODY = { id: 8, name: 'prev' } as const
export const CONFIRM_LIST = { id: 9, name: 'conf' } as const
export const RESULT_BODY = { id: 10, name: 'res' } as const

export const HEADER_H = 36
export const FOOTER_H = 36

/** Firmware limits we design against. */
export const MAX_TEXT_CHARS = 1000
export const MAX_LIST_ITEMS = 20
export const MAX_LIST_ITEM_CHARS = 60
