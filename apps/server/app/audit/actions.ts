'use server'

import type { AuditEntry } from '@pagerline/shared'
import { headers } from 'next/headers'
import { listAudit } from '@/lib/audit'
import { clientIp, verifyAdminSecret } from '@/lib/auth'

export interface AuditFormState {
  ok: boolean | null
  message: string
  entries: AuditEntry[]
}

/** Re-checks the typed ADMIN_SECRET on every submit (no session, brute-force limited); returns the newest 100 rows. */
export async function loadAudit(_prev: AuditFormState, formData: FormData): Promise<AuditFormState> {
  const secret = formData.get('adminSecret')
  const check = await verifyAdminSecret(
    typeof secret === 'string' ? secret : null,
    clientIp(await headers()),
    'page.audit',
  )
  if (check !== 'ok') {
    const message = check === 'limited' ? 'too many failed attempts, try again in 10 minutes' : 'wrong admin secret'
    return { ok: false, message, entries: [] }
  }
  const entries = await listAudit(100, null)
  return { ok: true, message: `${entries.length} newest entries`, entries }
}
