import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const STORAGE_KEY = 'pagerline.deviceToken'

/**
 * Resolve the device token at runtime; nothing is baked into the bundle.
 *
 * Dev provisioning (until pairing lands): open the app once with `?token=<DEVICE_TOKEN>`.
 * The token is persisted through the bridge storage (falling back to WebView
 * localStorage) and stripped from the URL. Returns '' when none is known → mock mode.
 */
export async function loadDeviceToken(bridge: EvenAppBridge): Promise<string> {
  const url = new URL(window.location.href)
  const fromQuery = url.searchParams.get('token')?.trim() ?? ''
  if (fromQuery) {
    await store(bridge, fromQuery)
    url.searchParams.delete('token')
    window.history.replaceState(null, '', url.toString())
    return fromQuery
  }
  return read(bridge)
}

async function store(bridge: EvenAppBridge, token: string): Promise<void> {
  let saved = false
  try {
    saved = await bridge.setLocalStorage(STORAGE_KEY, token)
  } catch (err) {
    console.warn('bridge.setLocalStorage failed, using WebView localStorage', err)
  }
  if (!saved) window.localStorage.setItem(STORAGE_KEY, token)
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
