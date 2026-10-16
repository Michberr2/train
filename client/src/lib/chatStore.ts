// Durable local chat store backed by IndexedDB.
//
// WHY: the full chat history (with generated docs/decks/images) can run several MB.
// localStorage caps at ~5MB PER ORIGIN and is shared with other keys (a logo cache,
// flows, settings), so a big history overflows the quota — the write is rejected and
// the app renders EMPTY ("where did all my files go?"). IndexedDB has a far larger
// quota (hundreds of MB+), so the complete history always fits locally. localStorage
// keeps only a lightweight copy for instant first paint; the server remains the backup.
//
// Tiny promise wrapper — no dependency. All ops fail SOFT (return null / resolve) so a
// browser without IndexedDB, or a private-mode block, never breaks the app.

import { getToken } from './localAuth'

const DB_NAME = 'nalu'
const STORE = 'kv'
const CHATS_KEY = 'chats-full'
const UNOWNED_KEY = 'chats-unowned-v1'
// Client-only, deliberately outside sync's `nalu-` namespace. If deletion fails,
// this survives a reload so the next account cannot read the old legacy cache.
const CLEAR_PENDING_KEY = 'nalu.idb-reset-pending'

let generation = 0
let epoch = new AbortController()
let operations: Promise<unknown> = Promise.resolve()
let readable = true
type Scope = { token: string | null; generation: number; signal: AbortSignal }
function token(): string | null { try { return getToken() } catch { return null } }
function snapshot(): Scope { return { token: token(), generation, signal: epoch.signal } }
function current(scope: Scope): boolean { return scope.generation === generation && scope.token === token() && !scope.signal.aborted }
function pendingClear(): string | null { try { return localStorage.getItem(CLEAR_PENDING_KEY) } catch { return null } }
function finishClear(id: string | null): void {
  try { if (id !== null && pendingClear() === id) localStorage.removeItem(CLEAR_PENDING_KEY) } catch { /* Keep reads blocked if the marker cannot be removed. */ }
}
function enqueue<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  const result = operations.then(work).catch(() => fallback)
  operations = result
  return result
}

function openDb(signal?: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-idb')); return }
    if (signal?.aborted) { reject(new Error('stale-idb')); return }
    const req = indexedDB.open(DB_NAME, 1)
    let settled = false
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
    const fail = () => { if (!settled) { settled = true; cleanup(); reject(new Error('idb-unavailable')) } }
    const abort = () => fail()
    // A blocked upgrade must not hold every later cache operation indefinitely.
    const timeout = setTimeout(fail, 5000)
    signal?.addEventListener('abort', abort, { once: true })
    req.onupgradeneeded = () => {
      if (settled || signal?.aborted) { req.transaction?.abort(); return }
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      if (settled || signal?.aborted) { db.close(); fail(); return }
      settled = true; cleanup()
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = fail
    req.onblocked = fail
  })
}

function transaction(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: unknown) => void, abort: () => void) => IDBRequest | void, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    let settled = false, result: unknown = null
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true; cleanup()
      if (ok) resolve(result)
      else reject(new Error('idb-transaction-failed'))
    }
    const abort = () => { try { tx.abort() } catch { /* already finished */ } finish(false) }
    const timeout = setTimeout(abort, 10000)
    tx.oncomplete = () => finish(true)
    tx.onerror = tx.onabort = () => finish(false)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    try {
      const req = action(tx.objectStore(STORE), (value) => { result = value }, abort)
      if (req) {
        req.onsuccess = () => { result = req.result }
        req.onerror = abort
      }
    } catch { abort() }
  })
}

async function run(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest, scope?: Scope): Promise<unknown> {
  if (scope && !current(scope)) return null
  const db = await openDb(scope?.signal)
  try {
    if (scope && !current(scope)) return null
    const result = await transaction(db, mode, action, scope?.signal)
    return scope && !current(scope) ? null : result
  } finally { db.close() }
}

/** Read the full chats JSON string (or null if none / unavailable). */
export async function idbGetChats(): Promise<string | null> {
  const scope = snapshot()
  const result = await enqueue(() => readable && !pendingClear() ? run('readonly', (store) => store.get(CHATS_KEY), scope) : Promise.resolve(null), null)
  return current(scope) && readable && !pendingClear() && typeof result === 'string' ? result : null
}

/** Persist the full chats JSON string. Fails soft (never throws). */
export async function idbSetChats(json: string): Promise<void> {
  const scope = snapshot()
  await enqueue(async () => {
    const clearing = pendingClear()
    const result = await run('readwrite', (store) => store.put(json, CHATS_KEY), scope)
    if (current(scope) && result !== null) { readable = true; finishClear(clearing) }
  }, undefined)
}

/** Invalidate pending session work immediately, then remove the legacy cache.
 * Cleanup is unconditional: a new token may already be installed by the time
 * this queued delete executes. New reads/writes always wait behind it.
 */
export function idbClearChats(): Promise<void> {
  const { clearing, marker } = invalidate()
  return enqueue(async () => {
    await run('readwrite', (store) => store.delete(CHATS_KEY))
    if (generation === clearing) { readable = true; finishClear(marker) }
  }, undefined)
}

function invalidate(): { clearing: number; marker: string } {
  generation += 1
  const clearing = generation
  readable = false
  const marker = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
  try { localStorage.setItem(CLEAR_PENDING_KEY, marker) } catch { /* In-memory invalidation still protects this document if storage is blocked/full. */ }
  epoch.abort()
  epoch = new AbortController()
  return { clearing, marker }
}

/** Preserve unknown ownership without assigning it to the current account.
 * The archive and removal share one transaction. A failure retains the active
 * cache and all caller-owned local entries; this function never clears those.
 * Queued cleanup must finish even if the session changes: no account is claimed.
 */
export function quarantineUnownedData(entries: Record<string, string>): Promise<boolean> {
  const preserved = Object.fromEntries(Object.entries(entries).filter(([key, value]) => key.startsWith('nalu-') && key !== 'nalu-token' && key !== 'nalu-data-owner' && typeof value === 'string'))
  const { clearing, marker } = invalidate()
  return enqueue(async () => {
    const db = await openDb()
    try {
      const committed = await transaction(db, 'readwrite', (store, result, abort) => {
        const active = store.get(CHATS_KEY)
        const archived = store.get(UNOWNED_KEY)
        let reads = 0
        const save = () => {
          if (++reads !== 2) return
          try {
            // An unexpected archive shape must not be overwritten or discarded.
            if (archived.result !== undefined && !Array.isArray(archived.result)) { abort(); return }
            const records = (archived.result || []) as unknown[]
            if (active.result !== undefined || Object.keys(preserved).length) {
              store.put([...records, { chats: active.result ?? null, entries: preserved }], UNOWNED_KEY)
            }
            store.delete(CHATS_KEY)
            result(true)
          } catch { abort() }
        }
        active.onsuccess = archived.onsuccess = save
        active.onerror = archived.onerror = abort
      })
      if (committed !== true) return false
      if (generation === clearing) { readable = true; finishClear(marker) }
      return true
    } finally { db.close() }
  }, false)
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function collection(value: unknown): Record<string, unknown>[] {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => record(item) && typeof item.id === 'string' && !!item.id.trim()) : []
  } catch { return [] }
}

/** Recover only IDs proved by an authoritative response for this session.
 * Return all matching versions for sync's existing artifact-preserving merge;
 * keep every original archive byte, including local-only/unmatched records.
 * No settings, credentials, tombstones or other collections are ever returned.
 */
export async function recoverUnownedData(serverData: Record<string, unknown>): Promise<{ chats?: string; projects?: string }> {
  const scope = snapshot()
  if (!scope.token) return {}
  const chatIds = new Set(collection(serverData['nalu-chats']).map((chat) => chat.id))
  const projectIds = new Set(collection(serverData['nalu-chat-projects']).map((project) => project.id))
  if (!chatIds.size && !projectIds.size) return {}
  const archived = await enqueue(() => run('readonly', (store) => store.get(UNOWNED_KEY), scope), null)
  if (!current(scope) || !Array.isArray(archived)) return {}
  const chats: Record<string, unknown>[] = [], projects: Record<string, unknown>[] = []
  for (const entry of archived) {
    if (!record(entry)) continue
    const saved = record(entry.entries) ? entry.entries : {}
    chats.push(...collection(entry.chats).filter((chat) => chatIds.has(chat.id)))
    chats.push(...collection(saved['nalu-chats']).filter((chat) => chatIds.has(chat.id)))
    projects.push(...collection(saved['nalu-chat-projects']).filter((project) => projectIds.has(project.id)))
  }
  if (!current(scope)) return {}
  return { ...(chats.length ? { chats: JSON.stringify(chats) } : {}), ...(projects.length ? { projects: JSON.stringify(projects) } : {}) }
}

type AccountJournal = { chats?: string; entries: Record<string, string | null>; pending: Record<string, string | null> }
const accountKey = (owner: string) => `account-journal:${owner}`
const journal = (value: unknown): AccountJournal => {
  const data = record(value) ? value : {}
  const entries = (raw: unknown): Record<string, string | null> => record(raw)
    ? Object.fromEntries(Object.entries(raw).filter(([key, value]) => key.startsWith('nalu-') && key !== 'nalu-token' && key !== 'nalu-data-owner' && (typeof value === 'string' || value === null))) as Record<string, string | null> : {}
  return { ...(typeof data.chats === 'string' ? { chats: data.chats } : {}), entries: entries(data.entries), pending: entries(data.pending) }
}

/** The durable outbox belongs to a verified account, never to its session token.
 * Clearing the active session does not delete this journal. Only that same
 * verified owner may restore it on a later sign-in.
 */
export async function idbGetAccountJournal(owner: string): Promise<AccountJournal | null> {
  const scope = snapshot()
  if (!scope.token || localStorage.getItem('nalu-data-owner') !== owner) return null
  const value = await enqueue(() => run('readonly', store => store.get(accountKey(owner)), scope), null)
  return current(scope) && value ? journal(value) : null
}

export async function idbQueueSync(owner: string, entries: Record<string, string | null>): Promise<boolean> {
  const scope = snapshot()
  if (!scope.token || localStorage.getItem('nalu-data-owner') !== owner) return false
  return enqueue(async () => {
    if (!current(scope)) return false
    const db = await openDb(scope.signal)
    try {
      const result = await transaction(db, 'readwrite', (store, result, abort) => {
        const req = store.get(accountKey(owner))
        req.onerror = abort
        req.onsuccess = () => {
          const saved = journal(req.result)
          store.put({ ...saved, entries: { ...saved.entries, ...entries }, pending: { ...saved.pending, ...entries } }, accountKey(owner))
          result(true)
        }
      }, scope.signal)
      return current(scope) && result === true
    } finally { db.close() }
  }, false)
}

export async function idbAckSync(owner: string, entries: Record<string, string | null>): Promise<void> {
  const scope = snapshot()
  await enqueue(async () => {
    if (!current(scope)) return
    const db = await openDb(scope.signal)
    try {
      await transaction(db, 'readwrite', (store, _result, abort) => {
        const req = store.get(accountKey(owner)); req.onerror = abort
        req.onsuccess = () => {
          const saved = journal(req.result)
          for (const [key, value] of Object.entries(entries)) if (saved.pending[key] === value) delete saved.pending[key]
          store.put(saved, accountKey(owner))
        }
      }, scope.signal)
    } finally { db.close() }
  }, undefined)
}

/** Snapshot the outgoing owner's active cache BEFORE its queued clear. The
 * owner is captured while the active cache still has an explicit owner marker.
 * This operation is unconditional so a token change cannot discard unsent work.
 */
export function idbArchiveAccount(owner: string, entries: Record<string, string | null>, pending: Record<string, string | null> = entries): Promise<boolean> {
  // Stop reads/acknowledgements from the outgoing session before queuing the
  // archive. Otherwise a delayed old read can block opening the next account.
  // Invalidation blocks access; the cache itself is retained until this commits.
  invalidate()
  return enqueue(async () => {
    const db = await openDb()
    try {
      return await transaction(db, 'readwrite', (store, result, abort) => {
        const active = store.get(CHATS_KEY), saved = store.get(accountKey(owner))
        let reads = 0
        const archive = () => {
          if (++reads !== 2) return
          const previous = journal(saved.result)
          store.put({ ...previous, ...(typeof active.result === 'string' ? { chats: active.result } : {}), entries: { ...previous.entries, ...entries }, pending: { ...previous.pending, ...pending } }, accountKey(owner))
          result(true)
        }
        active.onsuccess = saved.onsuccess = archive
        active.onerror = saved.onerror = abort
      }) === true
    } finally { db.close() }
  }, false)
}
