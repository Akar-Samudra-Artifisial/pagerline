import type { Alert, AlertsResponse } from '@pagerline/shared'
import { MOCK_ALERTS } from './mock'

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')
const FORCE_MOCK = import.meta.env.VITE_MOCK === '1'

/** Device token is supplied at runtime (see token.ts); it is never part of the build. */
let deviceToken = ''

export function setDeviceToken(token: string): void {
  deviceToken = token
}

/** Mock data when forced, when no server is configured, or when no device token has been provided. */
export function isMock(): boolean {
  return FORCE_MOCK || API_BASE === '' || deviceToken === ''
}

/**
 * Fetch alerts newer than `since` (null → latest page).
 * Throws with a readable message on network/HTTP failure so the header can show it.
 */
export async function fetchAlerts(since: number | null): Promise<AlertsResponse> {
  if (isMock()) {
    const alerts = since === null ? MOCK_ALERTS : MOCK_ALERTS.filter((a) => a.seq > since)
    return { alerts, cursor: MOCK_ALERTS.reduce((m, a) => Math.max(m, a.seq), 0) }
  }

  const url = since === null ? `${API_BASE}/api/alerts` : `${API_BASE}/api/alerts?since=${since}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${deviceToken}` } })
  if (!res.ok) throw new Error(`GET /api/alerts → HTTP ${res.status}`)
  const body = (await res.json()) as Partial<AlertsResponse>
  if (!Array.isArray(body.alerts) || typeof body.cursor !== 'number') {
    throw new Error('GET /api/alerts → unexpected response shape')
  }
  return { alerts: body.alerts as Alert[], cursor: body.cursor }
}
