import type {
  ActionConfirmResult,
  ActionKind,
  ActionPreview,
  Alert,
  AlertsResponse,
  PairStartResponse,
  PairStatusResponse,
  SummaryResponse,
  VoiceResponse,
} from '@pagerline/shared'
import { ApiError } from './errors'
import {
  MOCK_ALERTS,
  mockConfirm,
  mockIntent,
  mockPairStart,
  mockPairStatus,
  mockSummary,
  mockVoice,
} from './mock'

export { ApiError }

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')
const FORCE_MOCK = import.meta.env.VITE_MOCK === '1'

/** Device token is supplied at runtime (see token.ts); it is never part of the build. */
let deviceToken = ''

export function setDeviceToken(token: string): void {
  deviceToken = token
}

export function hasDeviceToken(): boolean {
  return deviceToken !== ''
}

/** Mock data when forced or when no server is configured. A missing token means pairing, not mock. */
export function isMock(): boolean {
  return FORCE_MOCK || API_BASE === ''
}

/** Where the user approves a pairing code. */
export function pairUrl(): string {
  return isMock() ? 'pagerline.example/pair' : `${API_BASE}/pair`
}

/** A request body that is sent as-is with its own Content-Type (audio uploads). */
interface RawBody {
  raw: BodyInit
  contentType: string
}

function isRawBody(body: unknown): body is RawBody {
  return typeof body === 'object' && body !== null && 'raw' in body && 'contentType' in body
}

async function request<T>(method: 'GET' | 'POST', path: string, bearer: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  let payload: BodyInit | undefined
  if (isRawBody(body)) {
    headers['Content-Type'] = body.contentType
    payload = body.raw
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload, cache: 'no-store' })
  } catch {
    throw new ApiError(0, 'Server unreachable')
  }
  const parsed: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const error =
      parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `HTTP ${res.status}`
    throw new ApiError(res.status, error)
  }
  if (!parsed || typeof parsed !== 'object') throw new ApiError(res.status, `${method} ${path}: bad response`)
  return parsed as T
}

/**
 * Fetch alerts newer than `since` (null → latest page).
 * Throws ApiError (status 401 = token revoked/unknown) so the caller can re-pair.
 */
export async function fetchAlerts(since: number | null): Promise<AlertsResponse> {
  if (isMock()) {
    const alerts = since === null ? MOCK_ALERTS : MOCK_ALERTS.filter((a) => a.seq > since)
    return { alerts, cursor: MOCK_ALERTS.reduce((m, a) => Math.max(m, a.seq), 0) }
  }
  const path = since === null ? '/api/alerts' : `/api/alerts?since=${since}`
  const body = await request<Partial<AlertsResponse>>('GET', path, deviceToken)
  if (!Array.isArray(body.alerts) || typeof body.cursor !== 'number') {
    throw new ApiError(200, 'GET /api/alerts: unexpected response shape')
  }
  return { alerts: body.alerts as Alert[], cursor: body.cursor }
}

export function startPairing(): Promise<PairStartResponse> {
  if (isMock()) return Promise.resolve(mockPairStart())
  return request<PairStartResponse>('POST', '/api/pair/start', '')
}

export function pairingStatus(pollSecret: string): Promise<PairStatusResponse> {
  if (isMock()) return Promise.resolve(mockPairStatus(pollSecret))
  return request<PairStatusResponse>('GET', '/api/pair/status', pollSecret)
}

export function createIntent(alertId: string, action: ActionKind): Promise<ActionPreview> {
  if (isMock()) return mockIntent(alertId, action)
  return request<ActionPreview>('POST', '/api/actions/intent', deviceToken, { alertId, action })
}

export function confirmAction(requestId: string, nonce: string): Promise<ActionConfirmResult> {
  if (isMock()) return mockConfirm(requestId, nonce)
  return request<ActionConfirmResult>('POST', '/api/actions/confirm', deviceToken, { requestId, nonce })
}

/** Recorded audio ready for upload: raw PCM s16le mono, or a browser container (webm/ogg/mp4). */
export interface VoiceClip {
  data: Blob
  /** MIME type without parameters, e.g. `audio/pcm`, `audio/webm`. */
  contentType: string
  /** PCM only. */
  sampleRate?: number
}

/** Transcribe + classify a spoken command. Never runs an action (see VoiceIntent). */
export function sendVoice(clip: VoiceClip, alertId: string): Promise<VoiceResponse> {
  if (isMock()) return mockVoice(alertId)
  const params = new URLSearchParams({ alertId })
  if (clip.contentType === 'audio/pcm') params.set('sampleRate', String(clip.sampleRate ?? 16000))
  return request<VoiceResponse>('POST', `/api/voice?${params.toString()}`, deviceToken, {
    raw: clip.data,
    contentType: clip.contentType,
  })
}

/** AI summary of one alert (server caches it); `refresh` asks for a new one. */
export function fetchSummary(alertId: string, refresh = false): Promise<SummaryResponse> {
  if (isMock()) return mockSummary(alertId, refresh)
  const q = refresh ? '?refresh=1' : ''
  return request<SummaryResponse>('POST', `/api/alerts/${encodeURIComponent(alertId)}/summary${q}`, deviceToken)
}
