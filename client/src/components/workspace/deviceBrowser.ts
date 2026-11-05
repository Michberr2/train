import { getToken } from '../../lib/localAuth'

// Honor the existing device preference without coupling the released Browser
// panel to the separately developed local-model loader.
const onDeviceOnly = () => { try { return JSON.parse(localStorage.getItem('device-local-ai-v1') || '{}').enabled === true } catch { return false } }
const endpoint = 'http://127.0.0.1:8877/device'
let connection: { token: string; device: string } | null = null
// Capability stays in this tab's memory; it is never synced or added to chat.
export const deviceConnected = () => !!connection && connection.token === getToken()
export async function deviceRequest(action: string, data: Record<string, unknown> = {}, signal?: AbortSignal, token = getToken()) {
  if (['workspace_run', 'workspace_resume'].includes(action) && onDeviceOnly()) throw new Error('This browser runs on your computer, but its agent currently uses Nalu’s online AI. Turn off on-device-only AI in Settings to run the agent. No page data was sent.')
  if (!token || token !== getToken()) throw Error('Sign in again to connect this computer.')
  if (action !== 'pair' && (!connection || connection.token !== token)) throw Error('Connect this computer in the Browser panel first.')
  let response: Response
  try {
    response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(connection?.token === token ? { 'X-Nalu-Device': connection.device } : {}) }, body: JSON.stringify({ ...data, action }), signal })
  } catch { throw Error('Start the Nalu browser companion on this computer and allow the browser’s local-network connection.') }
  const value = await response.json()
  if (getToken() !== token) { connection = null; throw Error('Your account changed. Reconnect this computer.') }
  if (!response.ok) { if (response.status === 401 || response.status === 403) connection = null; throw Error(value.error || 'Device request failed.') }
  if (action === 'pair') connection = { token, device: value.device }
  if (action === 'disconnect') connection = null
  return value
}
