import type { Client } from 'pg'

import { mergeChatMessages } from '../shared/chatMessages'
import { mergeChatTitle } from '../shared/chatTitle'
export { CHAT_ARTIFACT_FIELDS } from '../shared/chatMessages'
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)

export class ChatDataValidationError extends Error {}

function array(value: unknown): unknown[] | null {
  for (let i = 0; i < 6; i++) {
    if (Array.isArray(value)) return value
    if (typeof value !== 'string') return null
    try { value = JSON.parse(value) } catch { return null }
  }
  return Array.isArray(value) ? value : null
}

function id(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  // Older clients accepted numeric IDs; preserve them without coercing objects
  // into a shared "[object Object]" identity.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function deletedIds(value: unknown): Set<string> {
  return new Set((array(value) || []).map(value => id(record(value) ? value.id : value)).filter((value): value is string => value !== null))
}

function mergeOne(incoming: RecordValue, stored: RecordValue): RecordValue {
  const messages = mergeChatMessages(incoming.messages, stored.messages)
  // Incoming scalar metadata remains authoritative: moving a chat out of a
  // project intentionally omits projectId in JSON, so do not restore it.
  const result: RecordValue = { ...incoming, ...mergeChatTitle(incoming, stored), messages }
  if (result.attachments == null && stored.attachments != null) result.attachments = stored.attachments
  return result
}

/** Missing chats mean a stale device snapshot. Only explicit tombstones delete. */
export function mergeChatHistory(incoming: unknown[], stored: unknown[], deleted = new Set<string>()): RecordValue[] {
  const previous = new Map<string, RecordValue>(), merged = new Map<string, RecordValue>()
  for (const value of stored) {
    if (!record(value)) continue
    const key = id(value.id)
    if (key === null || deleted.has(key)) continue
    const existing = previous.get(key)
    previous.set(key, existing ? mergeOne(value, existing) : value)
  }
  for (const value of incoming) {
    if (!record(value)) continue
    const key = id(value.id)
    if (key === null || deleted.has(key)) continue
    merged.set(key, mergeOne(value, merged.get(key) || previous.get(key) || {}))
  }
  for (const [key, value] of previous) if (!merged.has(key)) merged.set(key, mergeOne(value, {}))
  return [...merged.values()]
}

const read = async (client: Client, owner: string, key: string): Promise<unknown> =>
  (await client.query('SELECT value FROM nalu_user_data WHERE user_id = $1 AND key = $2', [owner, key])).rows[0]?.value
const write = async (client: Client, owner: string, key: string, value: unknown): Promise<void> => {
  await client.query(`INSERT INTO nalu_user_data (user_id, key, value, updated_at)
    VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [owner, key, JSON.stringify(value)])
}
const encodeLike = (value: unknown[], source: unknown): unknown => typeof source === 'string' ? JSON.stringify(value) : value

/** Shared mutation rules for PostgreSQL transactions and Cloudflare revision
 * commits. Missing history never means deletion; tombstones remain explicit. */
export function chatDataChanges(key: 'nalu-chats' | 'nalu-deleted-chats', value: unknown, stored: unknown, deletedValue: unknown): Array<{ key: string; value: unknown }> {
  const incoming = array(value)
  if (!incoming) throw new ChatDataValidationError('Chat history and deleted chat IDs must be arrays.')
  const deleted = deletedIds(deletedValue)
  if (key === 'nalu-deleted-chats') {
    for (const key of deletedIds(incoming)) deleted.add(key)
    return [{ key, value: encodeLike([...deleted], value) }, ...(stored === undefined ? [] : [{ key: 'nalu-chats', value: encodeLike(mergeChatHistory([], array(stored) || [], deleted), stored) }])]
  }
  return [{ key, value: encodeLike(mergeChatHistory(incoming, array(stored) || [], deleted), value) }]
}

// /api/data owns a new, connected pg.Client for each request. This function must
// run on that dedicated connection, never on a shared/interleaved transaction.
// Both keys share the owner lock, including before the first history row exists.
export async function writeChatData(client: Client, owner: string, key: 'nalu-chats' | 'nalu-deleted-chats', value: unknown): Promise<void> {
  const incoming = array(value)
  if (!incoming) throw new ChatDataValidationError('Chat history and deleted chat IDs must be arrays.')
  await client.query('BEGIN')
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('nalu-chat-data'), hashtext($1))", [owner])
    const stored = await read(client, owner, 'nalu-chats')
    const deleted = await read(client, owner, 'nalu-deleted-chats')
    for (const update of chatDataChanges(key, value, stored, deleted)) await write(client, owner, update.key, update.value)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}


/** Append one identified turn under the same account lock used by web/desktop
 * snapshots and tombstones. Retried uploads cannot duplicate or resurrect it. */
export async function appendConversationTurn(client: Client, owner: string, turn: {chatId: string; turnId: string; user: string; assistant: string; source: string}): Promise<boolean> {
  await client.query('BEGIN')
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('nalu-chat-data'), hashtext($1))", [owner])
    const stored=await read(client,owner,'nalu-chats')
    const chats=stored===undefined?[]:array(stored)
    if(!chats)throw new ChatDataValidationError('Saved conversation history could not be read.')
    const deleted=deletedIds(await read(client,owner,'nalu-deleted-chats'))
    if(deleted.has(turn.chatId)){await client.query('COMMIT');return false}
    const old=chats.find(chat=>record(chat)&&chat.id===turn.chatId) as RecordValue|undefined
    const before=old && Array.isArray(old.messages)?old.messages.filter(record):[]
    if(!before.some(message=>message.id===turn.turnId+':user')){
      const now=Date.now()
      const chat={...old,id:turn.chatId,title:old?.title||turn.user.slice(0,80),source:turn.source,createdAt:old?.createdAt||now,updatedAt:now,messages:[...before,{id:turn.turnId+':user',role:'user',content:turn.user},{id:turn.turnId+':assistant',role:'assistant',content:turn.assistant}]}
      const next=[chat,...chats.filter(value=>!record(value)||value.id!==turn.chatId)]
      await write(client,owner,'nalu-chats',encodeLike(next,stored??''))
    }
    await client.query('COMMIT');return true
  } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
}
