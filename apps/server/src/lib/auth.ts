import { safeEqual } from './crypto'

export interface DeviceAuth {
  deviceId: string
}

/** Device id reported for the shared dev token until pairing issues per-device tokens. */
export const STATIC_DEVICE_ID = 'static-dev-token'

/**
 * Temporary device auth: a single static bearer token from `DEVICE_TOKEN`.
 * Returns the authenticated device (for audit) or null. Will be replaced by
 * per-device tokens issued through pairing codes.
 */
export function authenticateDevice(request: Request): DeviceAuth | null {
  const expected = process.env.DEVICE_TOKEN
  if (!expected) return null
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (match === null || !safeEqual(match[1].trim(), expected)) return null
  return { deviceId: STATIC_DEVICE_ID }
}
