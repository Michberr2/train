import type { SwarmState } from './swarmTypes'

export interface SwarmAccount { owner: string; token: string }
export interface SwarmResponse { state: SwarmState; revision: number; projectId?: string }
export const sameSwarmAccount = (a: SwarmAccount | null, b: SwarmAccount | null) => !!a && !!b && a.owner === b.owner && a.token === b.token
export class SwarmSessionChanged extends Error { constructor() { super('Your account changed. Reopen Swarm to continue.'); this.name = 'SwarmSessionChanged' } }
export class SwarmRequestError extends Error {
  constructor(message: string, readonly status: number, readonly uncertain: boolean) { super(message); this.name = 'SwarmRequestError' }
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 500
const time = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15
const agents = new Set(['Nalu', 'Rocky', 'Milo'])
/** Reject malformed or sample payloads before rendering authenticated work. */
export function isLiveSwarmState(value: unknown): value is SwarmState {
  if (!record(value) || value.mode !== 'live' || value.version !== 1 || !Array.isArray(value.projects) || !Array.isArray(value.tasks) || !Array.isArray(value.messages) || !Array.isArray(value.turns)) return false
  if (!value.projects.every(p => record(p) && id(p.id) && typeof p.title === 'string' && typeof p.brief === 'string' && time(p.createdAt) && time(p.updatedAt) && Array.isArray(p.members) && p.members.length > 0 && p.members.every(m => typeof m === 'string' && agents.has(m)))) return false
  const projects = new Map(value.projects.map(p => [p.id, p]))
  const room = (projectId: unknown, thread: unknown) => typeof projectId === 'string' && projects.has(projectId) && (thread === 'group' || projects.get(projectId)!.members.includes(thread))
  if (!value.tasks.every(t => record(t) && id(t.id) && room(t.projectId, t.assignee) && typeof t.title === 'string' && typeof t.summary === 'string' && time(t.updatedAt) && ['queued', 'running', 'waiting', 'done', 'paused', 'failed', 'cancelled'].includes(String(t.status)) && (t.threads === undefined || Array.isArray(t.threads) && t.threads.length > 0 && t.threads.every(thread => room(t.projectId, thread))) && (t.progress === undefined || typeof t.progress === 'number' && Number.isFinite(t.progress)) && (t.chatId === undefined || id(t.chatId)))) return false
  if (!value.messages.every(m => record(m) && id(m.id) && room(m.projectId, m.thread) && (m.speaker === 'You' || room(m.projectId, m.speaker) && m.speaker !== 'group') && typeof m.content === 'string' && time(m.createdAt) && m.sample !== true)) return false
  if (!value.turns.every(t => record(t) && id(t.id) && room(t.projectId, t.thread) && room(t.projectId, t.replySpeaker) && t.replySpeaker !== 'group' && id(t.userMessageId) && id(t.replyId) && ['pending', 'completed', 'cancelled', 'failed'].includes(String(t.status)) && time(t.createdAt) && time(t.updatedAt))) return false
  return ['projects', 'tasks', 'messages', 'turns'].every(key => {
    const rows = value[key] as { id: string }[]
    return new Set(rows.map(row => row.id)).size === rows.length
  })
}
export async function requestSwarm(account: SwarmAccount, body: Record<string, unknown>, signal: AbortSignal, readAccount: () => SwarmAccount | null, request: typeof fetch = fetch): Promise<SwarmResponse> {
  const current = () => {
    if (!sameSwarmAccount(account, readAccount())) throw new SwarmSessionChanged()
    if (signal.aborted) throw new SwarmRequestError('The request was not confirmed. Please try again.', 0, true)
  }
  current()
  let response: Response
  try { response = await request('/api/swarm', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` }, body: JSON.stringify(body), signal }) }
  catch { current(); throw new SwarmRequestError('The request was not confirmed. Check your connection and try again.', 0, true) }
  current()
  const value: unknown = await response.json().catch(() => null)
  current()
  if (!response.ok) throw new SwarmRequestError(record(value) && typeof value.error === 'string' ? value.error : 'Swarm is unavailable. Please try again.', response.status, response.status >= 500 || response.status === 408)
  if (!record(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !isLiveSwarmState(value.state)) throw new SwarmRequestError('Swarm returned an incomplete update. Please try again.', response.status, true)
  return { state: value.state, revision: Number(value.revision), ...(id(value.projectId) ? { projectId: value.projectId } : {}) }
}
