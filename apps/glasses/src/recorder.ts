import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { VoiceClip } from './api'

/** Where the audio really came from; shown on screen so a demo never overstates it. */
export type MicSource = 'glasses' | 'browser'

/** Glasses mic PCM: 16 kHz s16le mono (assumed; the SDK does not document the rate). */
export const GLASSES_SAMPLE_RATE = 16_000
/** Fall back to the browser mic if the glasses send no PCM frame within this window. */
const FIRST_FRAME_TIMEOUT_MS = 1500
/** Server limit is 256 KB; stay under it whatever the source. */
const MAX_CLIP_BYTES = 250 * 1024
const BROWSER_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4'] as const

export class MicUnavailableError extends Error {}

/** One live recording. `stop()` resolves with the clip; `cancel()` discards it. */
export interface Recording {
  readonly source: MicSource
  stop(): Promise<VoiceClip | null>
  cancel(): void
}

type PcmSink = (frame: Uint8Array) => void

/** The glasses recording that owns the mic right now; only its owner may close it. */
let pcmSink: PcmSink | null = null
/** Starts run one at a time so an abandoned start never overlaps (and closes) a newer one. */
let startQueue: Promise<unknown> = Promise.resolve()

/** Feed `event.audioEvent.audioPcm` from the bridge listener; frames are dropped when not recording. */
export function feedPcm(frame: Uint8Array): void {
  pcmSink?.(frame)
}

/**
 * Start recording: glasses mic first, browser `getUserMedia` as fallback when
 * `audioControl` fails or no PCM frame arrives within 1.5 s.
 * `isCurrent` lets the caller abandon a start that was superseded meanwhile.
 * Starts are serialised: a new one waits until the previous start has settled.
 */
export function startRecording(bridge: EvenAppBridge, isCurrent: () => boolean): Promise<Recording> {
  const run = startQueue.then(() => startNow(bridge, isCurrent))
  startQueue = run.catch(() => undefined)
  return run
}

async function startNow(bridge: EvenAppBridge, isCurrent: () => boolean): Promise<Recording> {
  if (!isCurrent()) throw new MicUnavailableError('cancelled')
  const glasses = await startGlasses(bridge, isCurrent)
  if (glasses) return glasses
  if (!isCurrent()) throw new MicUnavailableError('cancelled')
  return startBrowser()
}

async function startGlasses(bridge: EvenAppBridge, isCurrent: () => boolean): Promise<Recording | null> {
  const frames: Uint8Array[] = []
  let bytes = 0
  let gotFrame: (() => void) | null = null
  const firstFrame = new Promise<void>((resolve) => {
    gotFrame = resolve
  })
  const mine: PcmSink = (frame) => {
    if (frame.length === 0) return
    gotFrame?.()
    if (bytes + frame.length > MAX_CLIP_BYTES) return
    frames.push(frame)
    bytes += frame.length
  }
  pcmSink = mine
  const close = () => {
    // A newer recording may own the mic by now: leave it alone.
    if (pcmSink !== mine) return
    pcmSink = null
    bridge.audioControl(false).catch(() => undefined)
  }

  let opened = false
  try {
    opened = await bridge.audioControl(true, AudioInputSource.Glasses)
  } catch {
    opened = false
  }
  if (!opened) {
    close()
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    firstFrame.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), FIRST_FRAME_TIMEOUT_MS)
    }),
  ])
  clearTimeout(timer)
  if (timedOut) {
    close()
    return null
  }
  if (!isCurrent()) {
    close()
    throw new MicUnavailableError('cancelled')
  }

  return {
    source: 'glasses',
    stop() {
      close()
      if (bytes === 0) return Promise.resolve(null)
      const data = new Blob(frames as BlobPart[], { type: 'audio/pcm' })
      return Promise.resolve({ data, contentType: 'audio/pcm', sampleRate: GLASSES_SAMPLE_RATE })
    },
    cancel: close,
  }
}

async function startBrowser(): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new MicUnavailableError('No microphone available')
  }
  const mimeType = BROWSER_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
  if (!mimeType) throw new MicUnavailableError('No supported audio format')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
  } catch {
    throw new MicUnavailableError('Microphone permission denied')
  }
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const release = () => stream.getTracks().forEach((t) => t.stop())
  recorder.start(250)

  return {
    source: 'browser',
    stop() {
      return new Promise((resolve) => {
        const finish = () => {
          release()
          const data = new Blob(chunks, { type: mimeType })
          // Oversized clips still go up: the server answers 413 and the user sees why.
          resolve(data.size === 0 ? null : { data, contentType: mimeType })
        }
        if (recorder.state === 'inactive') {
          finish()
          return
        }
        recorder.onstop = finish
        recorder.stop()
      })
    },
    cancel() {
      recorder.onstop = null
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    },
  }
}
