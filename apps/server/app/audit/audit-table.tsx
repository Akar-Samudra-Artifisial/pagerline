'use client'

import { useActionState } from 'react'
import { loadAudit, type AuditFormState } from './actions'

const initial: AuditFormState = { ok: null, message: '', entries: [] }

export function AuditTable() {
  const [state, load, loading] = useActionState(loadAudit, initial)
  return (
    <>
      <form action={load} style={{ display: 'flex', gap: 8, alignItems: 'end', marginBottom: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          Admin secret
          <input name="adminSecret" type="password" autoComplete="off" required />
        </label>
        <button disabled={loading}>Show audit log</button>
      </form>
      {state.ok !== null && (
        <p role="status" style={{ color: state.ok ? 'green' : 'crimson' }}>
          {state.message}
        </p>
      )}
      {state.entries.length > 0 && (
        <table cellPadding={6} style={{ borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th align="left">#</th>
              <th align="left">Time</th>
              <th align="left">Event</th>
              <th align="left">Actor</th>
              <th align="left">Alert</th>
              <th align="left">Detail</th>
            </tr>
          </thead>
          <tbody>
            {state.entries.map((e) => (
              <tr key={e.id} style={{ borderTop: '1px solid #eee', verticalAlign: 'top' }}>
                <td>{e.id}</td>
                <td>{e.createdAt}</td>
                <td>
                  <code>{e.event}</code>
                </td>
                <td>{e.actor ?? '—'}</td>
                <td>{e.alertId ? <code>{e.alertId.slice(0, 8)}</code> : '—'}</td>
                <td>
                  <code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(e.detail)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
