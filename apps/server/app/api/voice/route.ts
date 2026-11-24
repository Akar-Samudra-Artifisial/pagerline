import type { VoiceResponse } from '@pagerline/shared'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '@/db/client'
import { audit } from '@/lib/audit'
import { authenticateDevice } from '@/lib/auth'
import { corsHeaders, isUuid, json, preflight, readBytesLimited } from '@/lib/http'
import { reserveQuota } from '@/lib/quota'
import {
  audioFormat,
  MAX_VOICE_BYTES,
  MAX_VOICE_SECONDS,
  mockTranscript,
  parseIntent,
  pcmSeconds,
  sttConfigured,
  transcribe,
  wavSeconds,
} from '@/lib/voice'

export const maxDuration = 30

const VOICE_LIMIT = 20
const VOICE_WINDOW_MS = 10 * 60_000

export function OPTIONS(request: Request) {
  return preflight(request)
}

/**
 * Body = audio (raw PCM s16le mono or WAV/WebM/Ogg/MP3/M4A, ≤ 256 KB, ≤ ~8 s);
 * query `alertId` (optional context), `sampleRate` (PCM only, default 16000).
 * → 200 VoiceResponse. Transcribes and classifies only; never runs an action.
 */
export async function POST(request: Request) {
  const cors = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const device = await authenticateDevice(request)
  if (!device) return json({ error: 'unauthorized' }, 401, cors)

  const mock = mockTranscript(request)
  if (mock === null && !sttConfigured()) {
    console.error('[pagerline] CARTESIA_API_KEY is not configured')
    return json({ error: 'voice commands are not configured on this server' }, 503, cors)
  }

  const params = new URL(request.url).searchParams
  const alertIdRaw = params.get('alertId')
  if (alertIdRaw !== null && alertIdRaw !== '' && !isUuid(alertIdRaw)) {
    return json({ error: '`alertId` must be a uuid' }, 400, cors)
  }
  const format = audioFormat(request.headers.get('content-type'), params.get('sampleRate'))
  if (format === null) {
    return json(
      { error: 'Content-Type must be audio/pcm (s16le mono, ?sampleRate=16000), audio/wav, audio/webm, audio/ogg, audio/mpeg or audio/mp4' },
      415,
      cors,
    )
  }
  if ('error' in format) return json({ error: format.error }, 400, cors)

  const audio = await readBytesLimited(request, MAX_VOICE_BYTES)
  if (audio === null) return json({ error: `audio too large (max ${MAX_VOICE_BYTES / 1024} KB)` }, 413, cors)
  if (audio.length === 0) return json({ error: 'empty audio body' }, 400, cors)
  const seconds = format.kind === 'pcm' ? pcmSeconds(audio.length, format.sampleRate) : format.ext === 'wav' ? wavSeconds(audio) : null
  if (seconds !== null && seconds > MAX_VOICE_SECONDS) {
    return json({ error: `audio too long (max ${Math.floor(MAX_VOICE_SECONDS)} s)` }, 413, cors)
  }

  let alertId: string | undefined
  if (alertIdRaw) {
    const a = schema.alerts
    const [row] = await getDb().select({ id: a.id }).from(a).where(eq(a.id, alertIdRaw)).limit(1)
    if (!row) return json({ error: 'alert not found' }, 404, cors)
    alertId = row.id
  }

  const reserved = await reserveQuota(
    device.deviceId,
    'voice.request',
    VOICE_LIMIT,
    VOICE_WINDOW_MS,
    { bytes: audio.length, format: format.kind === 'pcm' ? `pcm@${format.sampleRate}` : format.ext, mock: mock !== null },
    alertId ?? null,
  )
  if (!reserved) return json({ error: `rate limit: ${VOICE_LIMIT} voice commands per 10 minutes per device` }, 429, cors)

  const actor = `device:${device.deviceId}`
  let text: string
  if (mock !== null) {
    text = mock
  } else {
    const stt = await transcribe(audio, format)
    if (!stt.ok) {
      console.error(`[pagerline] voice STT failed: ${stt.message}`)
      // The reserved quota is kept on purpose: refunding would mean deleting audit rows, and a
      // failing provider should not be retried in a tight loop anyway.
      await audit({ event: 'voice.failed', actor, alertId, detail: { providerStatus: stt.status, reason: stt.message.slice(0, 80) } })
      return json({ error: 'speech-to-text failed, try again' }, 502, cors)
    }
    text = stt.text
  }

  const transcript = text.slice(0, 200)
  const intent = parseIntent(transcript)
  await audit({ event: 'voice.intent', actor, alertId, detail: { transcript: transcript.slice(0, 120), intent } })
  const body: VoiceResponse = { transcript, intent, ...(alertId ? { alertId } : {}) }
  return json(body, 200, cors)
}
