import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const STORAGE_KEY = 'pagerline.deviceToken'

/**
 * Resolve the device token at runtime; nothing is baked into the bundle.
 *
 * Priority: `?token=<DEVICE_TOKEN>` (dev provisioning, stripped from the URL and
 * persisted) → token stored by an earlier run or pairing → '' (caller starts pairing).
 * Storage is the bridge's key/value store, falling back to WebView localStorage.
 */
export async function loadDeviceToken(bridge: EvenAppBridge): Promise<string> {
  const url = new URL(window.location.href)
  const fromQuery = url.searchParams.get('token')?.trim() ?? ''
  if (fromQuery) {
    await saveDeviceToken(bridge, fromQuery)
    url.searchParams.delete('token')
    window.history.replaceState(null, '', url.toString())
    return fromQuery
  }
  return read(bridge)
}

export async function saveDeviceToken(bridge: EvenAppBridge, token: string): Promise<void> {
  let saved = false
  try {
    saved = await bridge.setLocalStorage(STORAGE_KEY, token)
  } catch (err) {
    console.warn('bridge.setLocalStorage failed, using WebView localStorage', err)
  }
  if (!saved) window.localStorage.setItem(STORAGE_KEY, token)
}

/** Forget the token everywhere (revoked device or user-requested re-pair). */
export async function clearDeviceToken(bridge: EvenAppBridge): Promise<void> {
  try {
    await bridge.setLocalStorage(STORAGE_KEY, '')
  } catch (err) {
    console.warn('bridge.setLocalStorage failed while clearing token', err)
  }
  window.localStorage.removeItem(STORAGE_KEY)
}

async function read(bridge: EvenAppBridge): Promise<string> {
  try {
    const value = await bridge.getLocalStorage(STORAGE_KEY)
    if (value) return value
  } catch (err) {
    console.warn('bridge.getLocalStorage failed, using WebView localStorage', err)
  }
  return window.localStorage.getItem(STORAGE_KEY) ?? ''
}
