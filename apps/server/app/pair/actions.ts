'use server'

import { headers } from 'next/headers'
import { clientIp, verifyAdminSecret, type AdminCheck } from '@/lib/auth'
import { approvePairing, listDevices, revokeDevice, type DeviceSummary } from '@/lib/pairing'

export interface PairFormState {
  ok: boolean | null
  message: string
  devices: DeviceSummary[] | null
}

function field(formData: FormData, name: string): string {
  const v = formData.get(name)
  return typeof v === 'string' ? v : ''
}

/**
 * Every admin action re-checks the typed ADMIN_SECRET (no cookie/session is kept), with the
 * shared brute-force limit. Next's Server Action Origin/Host check covers CSRF.
 */
async function checkAdmin(formData: FormData, surface: string): Promise<AdminCheck> {
  return verifyAdminSecret(field(formData, 'adminSecret'), clientIp(await headers()), surface)
}

function denied(check: Exclude<AdminCheck, 'ok'>): PairFormState {
  return {
    ok: false,
    message: check === 'limited' ? 'too many failed attempts, try again in 10 minutes' : 'wrong admin secret',
    devices: null,
  }
}

export async function approveAction(_prev: PairFormState, formData: FormData): Promise<PairFormState> {
  const check = await checkAdmin(formData, 'page.pair.approve')
  if (check !== 'ok') return denied(check)
  const result = await approvePairing(field(formData, 'code'), field(formData, 'name'))
  return { ok: result.ok, message: result.message, devices: await listDevices() }
}

export async function revokeAction(_prev: PairFormState, formData: FormData): Promise<PairFormState> {
  const check = await checkAdmin(formData, 'page.pair.revoke')
  if (check !== 'ok') return denied(check)
  const result = await revokeDevice(field(formData, 'deviceId'))
  return { ok: result.ok, message: result.message, devices: await listDevices() }
}

export async function listAction(_prev: PairFormState, formData: FormData): Promise<PairFormState> {
  const check = await checkAdmin(formData, 'page.pair.list')
  if (check !== 'ok') return denied(check)
  const devices = await listDevices()
  return { ok: true, message: `${devices.length} device(s)`, devices }
}
