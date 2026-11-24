import type { VoiceIntent } from '@pagerline/shared'
import { VOICE_BODY } from '../ids'
import type { MicSource } from '../recorder'
import { clip } from './format'
import { header, textBox, type Page } from './layout'

/** `mock` = no microphone at all (offline mock mode scripts the speech). */
export type VoiceMic = MicSource | 'mock'

export type VoiceView =
  | { kind: 'starting' }
  | { kind: 'listening'; source: VoiceMic; secondsLeft: number }
  | { kind: 'transcribing'; source: VoiceMic }
  | { kind: 'heard'; source: VoiceMic; transcript: string; intent: VoiceIntent; next: string }
  | { kind: 'message'; title: string; detail?: string }

const HINT = 'Say: rerun · resolve · next · back · inbox · summary'

export function voiceBody(v: VoiceView): string {
  switch (v.kind) {
    case 'starting':
      return ['Starting microphone…', '', HINT, 'Double-tap: cancel'].join('\n')
    case 'listening':
      return [`Listening… (${v.secondsLeft}s)`, `mic: ${v.source}`, '', HINT, 'Tap: stop · Double-tap: cancel'].join('\n')
    case 'transcribing':
      return ['Transcribing…', `mic: ${v.source}`].join('\n')
    case 'heard':
      return [
        `Heard: "${clip(v.transcript, 120) || '…'}"`,
        `Intent: ${v.intent}`,
        `mic: ${v.source}`,
        '',
        v.next,
      ].join('\n')
    case 'message':
      return [v.title, ...(v.detail ? ['', clip(v.detail, 160)] : []), '', 'Returning to the alert…'].join('\n')
  }
}

export function voicePage(headerContent: string, v: VoiceView): Page {
  return { textObject: [header(headerContent), textBox(VOICE_BODY, voiceBody(v))] }
}
