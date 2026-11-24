import type { Alert, AlertSeverity } from '@pagerline/shared'

const SEVERITY_TAG: Record<AlertSeverity, string> = {
  critical: 'CRIT',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  info: 'INFO',
}

export function sevTag(alert: Alert): string {
  return SEVERITY_TAG[alert.severity] ?? alert.severity.toUpperCase()
}

export function ago(iso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const h = Math.round(min / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

export interface HeaderState {
  title: string
  openCount: number
  online: boolean
  mock: boolean
}

export function headerText(s: HeaderState): string {
  const clock = new Date().toTimeString().slice(0, 5)
  const link = s.mock ? 'MOCK' : s.online ? 'LIVE' : 'OFFLINE'
  return clip(`PAGERLINE · ${s.title} · ${s.openCount} open · ${link} · ${clock}`, 80)
}
