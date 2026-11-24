'use client'

import { useActionState } from 'react'
import { approveAction, listAction, revokeAction, type PairFormState } from './actions'

const initial: PairFormState = { ok: null, message: '', devices: null }

const box = { border: '1px solid #ccc', borderRadius: 8, padding: 16, marginBottom: 16, maxWidth: 560 }
const row = { display: 'flex', flexDirection: 'column' as const, gap: 4, marginBottom: 8 }

function SecretField() {
  return (
    <label style={row}>
      Admin secret
      <input name="adminSecret" type="password" autoComplete="off" required />
    </label>
  )
}

function Status({ state }: { state: PairFormState }) {
  if (state.ok === null) return null
  return (
    <p role="status" style={{ color: state.ok ? 'green' : 'crimson' }}>
      {state.message}
    </p>
  )
}

export function PairForms() {
  const [approveState, approve, approving] = useActionState(approveAction, initial)
  const [revokeState, revoke, revoking] = useActionState(revokeAction, initial)
  const [listState, list, listing] = useActionState(listAction, initial)
  const devices = listState.devices ?? revokeState.devices ?? approveState.devices

  return (
    <>
      <form action={approve} style={box}>
        <h2>Approve a pairing code</h2>
        <label style={row}>
          Code shown on the glasses
          <input name="code" required maxLength={8} autoCapitalize="characters" autoComplete="off" />
        </label>
        <label style={row}>
          Device name
          <input name="name" defaultValue="Even G2" maxLength={60} />
        </label>
        <SecretField />
        <button disabled={approving}>Approve</button>
        <Status state={approveState} />
      </form>

      <form action={revoke} style={box}>
        <h2>Revoke a device</h2>
        <label style={row}>
          Device id
          <input name="deviceId" required autoComplete="off" />
        </label>
        <SecretField />
        <button disabled={revoking}>Revoke</button>
        <Status state={revokeState} />
      </form>

      <form action={list} style={box}>
        <h2>Devices</h2>
        <SecretField />
        <button disabled={listing}>List devices</button>
        <Status state={listState} />
      </form>

      {devices && (
        <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="left">Id</th>
              <th align="left">Claimed</th>
              <th align="left">Last seen</th>
              <th align="left">Revoked</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>
                  <code>{d.id}</code>
                </td>
                <td>{d.claimed ? 'yes' : 'no'}</td>
                <td>{d.lastSeenAt ?? '—'}</td>
                <td>{d.revokedAt ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
