import type { VoiceIntent } from '@pagerline/shared'
import { isProduction } from './auth'

// ---------------------------------------------------------------------------
// Rule-based intent parser (no LLM): only the transcript is parsed, never alert content.

/** Negates a write action wherever it appears ("don't rerun", "undo resolve", "rerun, cancel"). */
const NEGATION = /\b(don'?t|do not|dont|never|cancel|stop|undo|not)\b/
/** "no" only negates when it comes before the action verb ("no, don't…", "no rerun"); "rerun, no wait" stays rerun. */
const NO_WORD = /\bno\b/
const RERUN = /\b(re-? ?run|retry|run (it|this|that|the [a-z]+) again|restart (the )?(build|job|jobs|workflow|pipeline|ci))\b/
const RESOLVE = /\b(resolve|resolved|mark (it |this |that )?(as )?(resolved|fixed|done)|close (the |this |that )?(issue|incident))\b/
const SUMMARY = /\b(summary|summari[sz]e|explain|what happened|what'?s (wrong|going on|up)|tl ?dr|details?)\b/
/** "back to the inbox" is inbox, not back. */
const INBOX_RETURN = /\b(back|return|go) to (the )?(inbox|home|alert list|list|alerts)\b/
/** Strict on purpose: bare "list"/"home" inside another command ("list the next alert") is not inbox. */
const INBOX = /\b(inbox|home ?screen|go home|all alerts|alerts? list|list (of |all )?alerts|show (me )?(all )?(the )?alerts)\b/
const BACK = /\b(back|previous|prev|return)\b/
const NEXT = /\b(next|skip|forward)\b/

/** Longer utterances are not treated as commands. */
const MAX_COMMAND_WORDS = 12

export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Map a transcript to one intent. Ambiguity (both rerun and resolve), negation of a write
 * action, or a long sentence → `unknown`. Write intents are only returned, never executed.
 */
export function parseIntent(transcript: string): VoiceIntent {
  const t = normalizeTranscript(transcript)
  if (!t || t.split(' ').length > MAX_COMMAND_WORDS) return 'unknown'
  const rerun = RERUN.exec(t)
  const resolve = RESOLVE.exec(t)
  const verb = rerun ?? resolve
  if (verb) {
    if (rerun && resolve) return 'unknown'
    const no = NO_WORD.exec(t)
    if (NEGATION.test(t) || (no && no.index < verb.index)) return 'unknown'
    return rerun ? 'rerun' : 'resolve'
  }
  if (SUMMARY.test(t)) return 'summary'
  if (INBOX_RETURN.test(t)) return 'inbox'
  if (NEXT.test(t)) return 'next'
  if (BACK.test(t)) return 'back'
  if (INBOX.test(t)) return 'inbox'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Audio formats accepted by POST /api/voice.

/**
 * Duration is checked exactly for raw PCM and PCM WAV only. Compressed containers
 * (WebM/Ogg/MP3/M4A) are bounded by MAX_VOICE_BYTES alone — no parser on purpose; at
 * browser Opus bitrates 256 KB can exceed 8 s, which only costs STT time (quota-limited).
 */
export const MAX_VOICE_BYTES = 256 * 1024
export const MAX_VOICE_SECONDS = 8.5

/** Container MIME types passed to Cartesia as-is (it decodes them). */
const CONTAINER_TYPES: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
}
/** Raw PCM s16le mono, rate from `?sampleRate=`. */
const PCM_TYPES = new Set(['audio/pcm', 'audio/l16', 'application/octet-stream'])

export type AudioFormat =
  | { kind: 'pcm'; sampleRate: number; mime: string }
  | { kind: 'container'; ext: string; mime: string }

/** Parse Content-Type (+ `sampleRate` query for PCM); null when unsupported. */
export function audioFormat(contentType: string | null, sampleRateRaw: string | null): AudioFormat | { error: string } | null {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (CONTAINER_TYPES[mime]) return { kind: 'container', ext: CONTAINER_TYPES[mime], mime }
  if (!PCM_TYPES.has(mime)) return null
  const rateParam = /rate=(\d+)/i.exec(contentType ?? '')?.[1] // audio/L16;rate=16000
  const sampleRate = Number(sampleRateRaw ?? rateParam ?? '16000')
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
    return { error: 'sampleRate must be an integer between 8000 and 48000' }
  }
  return { kind: 'pcm', sampleRate, mime }
}

/** Duration of raw PCM s16le mono, in seconds. */
export function pcmSeconds(bytes: number, sampleRate: number): number {
  return bytes / (2 * sampleRate)
}

/** Rough duration of a PCM WAV from its header (`data` chunk / byte rate); null when not parseable. */
export function wavSeconds(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  const byteRate = buf.readUInt32LE(28)
  if (byteRate <= 0) return null
  return (buf.length - 44) / byteRate
}

// ---------------------------------------------------------------------------
// Speech-to-text (Cartesia batch STT).

const CARTESIA_STT_URL = 'https://api.cartesia.ai/stt'
const CARTESIA_VERSION = '2025-04-16'
const STT_MODEL = 'ink-whisper'
const STT_TIMEOUT_MS = 15_000

export type SttResult = { ok: true; text: string } | { ok: false; status: number | null; message: string }

/** Dev/selftest only: `VOICE_STT_MOCK=1` + header `x-mock-transcript` skips Cartesia. Never in production. */
export function mockTranscript(request: Request): string | null {
  if (isProduction() || process.env.VOICE_STT_MOCK !== '1') return null
  return request.headers.get('x-mock-transcript')
}

export function sttConfigured(): boolean {
  return Boolean(process.env.CARTESIA_API_KEY)
}

export async function transcribe(audio: Buffer, format: AudioFormat): Promise<SttResult> {
  const key = process.env.CARTESIA_API_KEY?.trim()
  if (!key) return { ok: false, status: null, message: 'CARTESIA_API_KEY missing' }

  const url = new URL(CARTESIA_STT_URL)
  const filename = format.kind === 'pcm' ? 'audio.pcm' : `audio.${format.ext}`
  if (format.kind === 'pcm') {
    url.searchParams.set('encoding', 'pcm_s16le')
    url.searchParams.set('sample_rate', String(format.sampleRate))
  }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: format.kind === 'pcm' ? 'application/octet-stream' : format.mime }), filename)
  form.append('model', STT_MODEL)
  form.append('language', 'en')

  try {
    const res = await fetch(url, {
      method: 'POST',
      // One auth header, as documented for Cartesia-Version 2025-04-16 (skill cartesia-voice).
      headers: { 'X-API-Key': key, 'Cartesia-Version': CARTESIA_VERSION },
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    })
    if (!res.ok) {
      // Status only: the provider body may echo request details; it is never logged or audited.
      await res.body?.cancel()
      return { ok: false, status: res.status, message: `Cartesia STT HTTP ${res.status}` }
    }
    const data = (await res.json()) as { text?: unknown }
    return { ok: true, text: typeof data.text === 'string' ? data.text.trim() : '' }
  } catch (err) {
    return { ok: false, status: null, message: `Cartesia STT request failed: ${err instanceof Error ? err.name : 'unknown'}` }
  }
}
