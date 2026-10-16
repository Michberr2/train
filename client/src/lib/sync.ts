import { PROJECT_COLLECTIONS, projectArray, projectContent, mergeProjectRecords } from '../../../shared/projectMerge'
import { BRAND_KEY, quarantineLegacyBrand } from './brandStorage'
import { mergeChatMessages } from '../../../shared/chatMessages'
import { mergeChatTitle } from '../../../shared/chatTitle'
// Per-user data sync: mirrors the Dashboard's `nalu-*` localStorage keys to
// Neon Postgres (via /api/data) so conversations, projects, plugins,
// automations, GitHub PAT, and settings persist server-side and follow the
// account across n4lu.ai/.com and devices.
//
// Strategy: localStorage stays the app's working store (zero Dashboard changes).
// On login we hydrate localStorage from the server; thereafter every `nalu-*`
// write is debounced and pushed up. Values are stored verbatim (the exact
// localStorage string), so it's lossless.

import { getToken } from './localAuth'
import { idbGetChats, idbSetChats, idbClearChats, quarantineUnownedData, recoverUnownedData, idbGetAccountJournal, idbQueueSync, idbAckSync, idbArchiveAccount } from './chatStore'
import { syncBodies } from './syncPayload'

const PREFIX = 'nalu-'
// Never sync these: the session token, and regeneratable render caches that would only
// bloat the DB + every hydrate and crowd out the real data in the first-paint budget.
const SKIP = new Set(['nalu-token', 'nalu-logo-img-cache', 'nalu-data-owner'])

let patched = false
let hydrated = false // true once the server load has succeeded this session
let cleared = false // true right after a sign-out wiped localStorage (until re-hydrate)
let pending: Record<string, string | null> = {}
let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0, loadRevision = 0
let sessionToken: string | null = null
let pendingToken: string | null = null
let flushing = false, retryDelay = 600
let flushController: AbortController | null = null
let loadTimer: ReturnType<typeof setTimeout> | null = null
let loadDelay = 1200
let latestChats: string | null = null
let inFlightEntries: Record<string, string | null> = {}
export type SyncState = 'loading' | 'saving' | 'saved' | 'pending' | 'error'
let syncState: SyncState = 'loading'
export function getSyncState(): SyncState { return syncState }
function reportState(state: SyncState): void {
  syncState = state
  window.dispatchEvent(new Event('nalu-sync-status'))
}
export function retrySync(): void {
  if (!hydrated) void loadFromServer()
  else void flush()
}

// True when local storage was just cleared for a sign-out. A component's
// unmount/tab-close persist flush checks this so it never re-writes the
// signed-out user's in-memory data back into the freshly-emptied storage.
export function sessionWasCleared(): boolean { return cleared }

/** Establish ownership before any local/server merge. Legacy caches have no
 * owner, so preserve them separately instead of assigning them to a new login.
 */
export async function prepareAccount(userId: string): Promise<boolean> {
  const token = getToken()
  if (!token || !quarantineLegacyBrand()) return false
  const owner = origGet('nalu-data-owner')
  if (owner === userId) return true
  if (!owner) {
    const entries: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX) || key === 'nalu-token' || key === 'nalu-data-owner') continue
      const value = origGet(key)
      if (value !== null) entries[key] = value
    }
    if (!await quarantineUnownedData(entries) || token !== getToken()) return false
  }
  if (!await clearLocal()) return false
  if (token !== getToken()) return false
  origSet('nalu-data-owner', userId)
  return true
}

// Collection keys we must NEVER clobber with an empty value before we've
// successfully hydrated from the server — otherwise a transient network failure
// on load could overwrite real chats/projects with "[]".
const COLLECTIONS = new Set(['nalu-chats', ...Object.keys(PROJECT_COLLECTIONS)])
const isEmptyish = (v: string | null) => v == null || v === '[]' || v === '{}' || v === '' || v === 'null'

// Regeneratable client-only caches that must NEVER be written into localStorage on
// hydrate — they can be large (a logo-image cache runs ~1MB) and would eat the ~5MB
// quota that the chat history needs. They rebuild on demand from their source, so a
// missing local copy costs only a re-render, never data.
const LOCAL_HYDRATE_SKIP = new Set(['nalu-logo-img-cache'])

// Original (unpatched) accessors so hydration/flush don't re-trigger sync.
const origSet = localStorage.setItem.bind(localStorage)
const origRemove = localStorage.removeItem.bind(localStorage)

async function flush(): Promise<void> {
  timer = null
  if (flushing) return
  const token = getToken()
  if (!token || token !== pendingToken || cleared) return
  const entries = pending
  pending = {}
  inFlightEntries = entries
  if (!Object.keys(entries).length) return
  const session = generation
  const controller = new AbortController()
  flushController = controller
  flushing = true
  reportState('saving')
  const owner = origGet('nalu-data-owner')
  let retry = true, succeeded = false
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    for (const body of await syncBodies(entries, token)) {
      if (session !== generation || token !== getToken()) return
      const response = await fetch('/api/data', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body, signal: controller.signal,
      })
      if (!response.ok) {
        retry = response.status !== 401 && response.status !== 403 && response.status !== 400
        throw new Error('Data save failed')
      }
      const result = await response.json().catch(() => null)
      if (session === generation && token === getToken() && result?.data) acceptProjectSnapshot(result.data, entries)
    }
    if (owner && session === generation && token === getToken()) await idbAckSync(owner, entries)
    succeeded = true
    retry = false
    retryDelay = 600
  } catch {
    if (session === generation && token === getToken()) {
      // Preserve failed values, with any newer local edit taking precedence.
      pending = { ...entries, ...pending }
      retryDelay = Math.min(30000, Math.max(1200, retryDelay * 2))
      reportState('pending')
    }
  } finally {
    clearTimeout(timeout)
    flushing = false
    flushController = null
    inFlightEntries = {}
    if (session === generation && succeeded) reportState(Object.keys(pending).length ? 'saving' : 'saved')
    if (pendingToken === getToken() && !cleared && Object.keys(pending).length
      && (session !== generation || succeeded || retry)) {
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, retry ? retryDelay : 600)
    }
  }
}

function schedule(key: string, value: string | null): void {
  const token = getToken()
  if (!token || token !== sessionToken || cleared) return
  if (pendingToken !== token) { pending = {}; pendingToken = token }
  // Guard: don't push an empty chats/projects value to the server until we've
  // confirmed (via a successful hydrate) that empty is the real state.
  if (!hydrated && COLLECTIONS.has(key) && isEmptyish(value)) return
  pending[key] = value
  const owner = origGet('nalu-data-owner')
  if (owner) void idbQueueSync(owner, { [key]: value }).then(ok => { if (!ok && token === getToken() && !cleared) reportState('error') })
  reportState('saving')
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 600)
}

// Every same-origin /api/* call carries the signed-in token, so server-side
// daily quotas meter the USER (25+/day) — not the shared anonymous IP bucket
// (3/day). Without this, signed-in users hit "free limit reached" at 3 videos.
let fetchPatched = false
function installApiAuth(): void {
  if (fetchPatched || typeof window === 'undefined') return
  fetchPatched = true
  const orig = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url && (url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`))) {
        const token = getToken()
        if (token) {
          const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
          if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
          return orig(input, { ...init, headers })
        }
      }
    } catch { /* fall through to the original call */ }
    return orig(input, init)
  }) as typeof window.fetch
}

/** Patch localStorage so every `nalu-*` write is pushed to the server. */
// Push the COMPLETE chats payload (with all doc/sheet/deck/design artifacts) to
// the server. The DB (Postgres) holds far more than localStorage, so artifacts
// live here even when the browser copy has to be slimmed. Call this from the
// chat persister with a full, artifact-preserving serialization.
export function pushChatsFull(fullJson: string): void {
  // NEVER sync an empty chats array. An empty value is only ever a transient/
  // uninitialized state (e.g. the persist effect firing on mount right after a
  // logout cleared localStorage) — pushing it would overwrite the server's real
  // history with "[]". Real deletions flow through the nalu-deleted-chats
  // tombstone, so the server still learns about them without an empty overwrite.
  if (isEmptyish(fullJson)) return
  // Signed in but not yet hydrated → DON'T push. Our copy may be MISSING chats made on
  // another device (the server merges by presence, so pushing an incomplete list would
  // DROP them). The change is safe in IndexedDB/localStorage meanwhile and pushes once
  // hydrate has merged the server's chats in (restore → state change → persist).
  latestChats = fullJson
  const token = getToken(), owner = origGet('nalu-data-owner')
  if (token && !hydrated) {
    if (owner) void idbQueueSync(owner, { 'nalu-chats': fullJson }).then(ok => { if (token === getToken() && !cleared) reportState(ok ? 'pending' : 'error') })
    return
  }
  schedule('nalu-chats', fullJson)
}

export function installSync(): void {
  installApiAuth()
  if (patched) return
  patched = true
  window.addEventListener('online', () => {
    // A stored token is not yet a verified owner (startup, another tab, or the
    // recovery-code screen can all precede AuthProvider's ownership check).
    if (!getToken() || getToken() !== sessionToken || cleared) return
    retrySync()
  })
  localStorage.setItem = (key: string, value: string) => {
    if (PROJECT_COLLECTIONS[key]) {
      const previous = new Map(projectArray(origGet(key) || '[]').map(item => [item.id, item]))
      value = JSON.stringify(projectArray(value).map(item => ({ ...item, _projectSync: item._projectSync || previous.get(item.id)?._projectSync || { revision: 0 } })))
    }
    origSet(key, value)
    // 'nalu-chats' is synced separately via pushChatsFull() with the COMPLETE,
    // artifact-preserving payload — NOT the localStorage value, which may have
    // been stripped of docs/artifacts to fit the browser's ~5MB quota. Syncing
    // the stripped value here is what silently destroyed users' saved docs.
    if (key === 'nalu-chats') return
    if (key.startsWith(PREFIX) && !SKIP.has(key)) schedule(key, value)
  }
  localStorage.removeItem = (key: string) => {
    origRemove(key)
    if (key.startsWith(PREFIX) && !SKIP.has(key)) schedule(key, null)
  }
}

// Chats/projects are MERGED (union) with whatever is already local, never
// blindly overwritten — so a not-yet-synced chat (e.g. created seconds before a
// hard refresh) is never wiped by a staler server copy. The richer version of a
// chat (more messages) wins.
const origGet = localStorage.getItem.bind(localStorage)
const safeArr = (s: string | null): Record<string, unknown>[] => {
  try { const a = s ? JSON.parse(s) : []; return Array.isArray(a) ? a : [] } catch { return [] }
}
// Ids the user has permanently deleted (union of local + server tombstones) —
// a deleted chat/project is filtered out of every merge, so it never comes back.
function deletedIds(key: string): Set<string> {
  try { const a = JSON.parse(origGet(key) || '[]'); return new Set(Array.isArray(a) ? a.map(String) : []) } catch { return new Set() }
}
// The heavy artifact fields on a message. The browser copy is tiered-DOWN to fit
// the ~5MB quota (docs/decks/designs stripped), while the SERVER copy keeps them.
// So a naive "local wins" merge would permanently drop artifacts on every reload.
const MSG_ARTIFACT_FIELDS = ['doc', 'sheet', 'deck', 'design', 'cad', 'video', 'email', 'image']

// Union one chat that exists on BOTH sides: take the fuller message list as the
// base (append-only chats keep a common prefix, so index alignment is safe), then
// restore any artifact/text field the base is missing from the other side. This
// heals the browser's stripped copy from the server's complete one (and vice-versa)
// instead of letting either overwrite the other.
function unionChat(local: Record<string, unknown>, server: Record<string, unknown>): Record<string, unknown> {
  const messagesOf = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
    ? value.filter((message): message is Record<string, unknown> => !!message && typeof message === 'object' && !Array.isArray(message)) : []
  const lm = messagesOf(local.messages)
  const sm = messagesOf(server.messages)
  const [base, other] = lm.length >= sm.length ? [local, server] : [server, local]
  const messages = mergeChatMessages(lm, sm)
  // Base wins scalar fields (title/notes/order); keep the base's attachments too.
  return { ...other, ...base, ...mergeChatTitle(base, other), messages }
}

function mergeChats(localStr: string | null, serverStr: string): string {
  const dead = deletedIds('nalu-deleted-chats')
  const byId = new Map<string, Record<string, unknown>>()
  for (const c of safeArr(serverStr)) if (c && c.id && !dead.has(String(c.id))) {
    const id = String(c.id), previous = byId.get(id)
    byId.set(id, previous ? unionChat(c, previous) : c)
  }
  for (const c of safeArr(localStr)) {
    if (!c || !c.id || dead.has(String(c.id))) continue
    const ex = byId.get(String(c.id))
    // On BOTH sides → union messages/artifacts (never let one strip the other).
    // Only local → keep local.
    byId.set(String(c.id), ex ? unionChat(c, ex) : c)
  }
  const merged = [...byId.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
  return JSON.stringify(merged)
}
// Write the merged chats into localStorage UNDER the ~5MB quota. A power user's full
// history (with every doc/deck/image artifact) can exceed the browser cap — writing it
// raw throws QuotaExceededError and leaves the app EMPTY (this is exactly the "where did
// my files go?" failure). So mirror the app's own tier-down: try full → strip heavy
// Studio artifacts → text-only → skeleton, guaranteeing the chat LIST + conversations
// always load. The COMPLETE copy (every artifact) always stays safe on the server, and
// the server restores any artifact a slimmed client later pushes back.
const isDataUrlLike = (s: unknown): boolean => typeof s === 'string' && s.startsWith('data:')
function setChatsLocal(mergedStr: string): void {
  const arr = safeArr(mergedStr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs = (c: any) => (Array.isArray(c.messages) ? (c.messages as Record<string, unknown>[]) : [])
  const stripArtifacts = (m: Record<string, unknown>) => {
    const o = { ...m }
    for (const f of MSG_ARTIFACT_FIELDS) delete o[f]
    if (isDataUrlLike(o.video)) delete o.video
    return o
  }
  const tiers: Array<() => string> = [
    () => mergedStr, // full (fits on browsers with a larger quota)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => JSON.stringify(arr.map((c: any) => ({ ...c, messages: msgs(c).map(stripArtifacts) }))), // drop heavy artifacts (kept on server)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => JSON.stringify(arr.map((c: any) => ({ id: c.id, title: c.title, titleUpdatedAt: c.titleUpdatedAt, createdAt: c.createdAt, projectId: c.projectId, notes: typeof c.notes === 'string' ? c.notes.slice(0, 4000) : c.notes, messages: msgs(c).map((m: Record<string, unknown>) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '', reasoning: m.reasoning })) }))), // text-only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => JSON.stringify(arr.map((c: any) => ({ id: c.id, title: c.title, titleUpdatedAt: c.titleUpdatedAt, createdAt: c.createdAt, projectId: c.projectId, messages: [] }))), // skeleton — guarantees the LIST survives
  ]
  for (const build of tiers) {
    try { origSet('nalu-chats', build()); return } catch { /* too big for this tier — fall to a lighter one */ }
  }
}
function mergeProjects(localStr: string | null, serverStr: string, key = 'nalu-chat-projects'): string {
  return JSON.stringify(mergeProjectRecords(serverStr, localStr || '[]', origGet(PROJECT_COLLECTIONS[key]) || '[]', true))
}
// A successful write returns the merged collection, including conflict copies.
// Rebase a newer local edit only when the acknowledged content is exactly the
// submitted content; another device's competing update is still a conflict.
function acceptProjectSnapshot(data: Record<string, unknown>, sent: Record<string, string | null>): void {
  if (!Object.keys(PROJECT_COLLECTIONS).some(key => data[key] != null)) return
  for (const key of Object.values(PROJECT_COLLECTIONS)) if (data[key] != null) origSet(key, mergeIdList(origGet(key), typeof data[key] === 'string' ? data[key] as string : JSON.stringify(data[key])))
  for (const key of Object.keys(PROJECT_COLLECTIONS)) {
    if (data[key] == null) continue
    const server = projectArray(data[key]), submitted = new Map(projectArray(sent[key] || '[]').map(item => [item.id, item]))
    const local = projectArray(origGet(key) || '[]').map(item => {
      const before = submitted.get(item.id), acknowledged = server.find(row => row.id === item.id)
      return before && acknowledged && projectContent(before) === projectContent(acknowledged) && item._projectSync?.revision === before._projectSync?.revision
        ? { ...item, _projectSync: acknowledged._projectSync } : item
    })
    const merged = mergeProjects(JSON.stringify(local), JSON.stringify(server), key)
    origSet(key, merged)
    if (pending[key] !== undefined) pending[key] = merged
  }
  window.dispatchEvent(new Event('nalu-hydrated'))
}
// Union tombstone lists on hydrate so a deletion made on ANY device is honored
// everywhere (append-only — deletes never un-delete).
function mergeIdList(localStr: string | null, serverStr: string): string {
  const s = new Set<string>()
  for (const raw of [serverStr, localStr]) {
    try { const a = raw ? JSON.parse(raw) : []; if (Array.isArray(a)) for (const x of a) { const id = typeof x === 'string' ? x : String((x as Record<string, unknown>)?.id ?? ''); if (id) s.add(id) } } catch { /* skip */ }
  }
  return JSON.stringify([...s])
}

/** Hydrate localStorage from the server, MERGING chats/projects so nothing is lost. */
export async function loadFromServer(): Promise<void> {
  const token = getToken()
  if (!token) return
  if (sessionToken && sessionToken !== token) {
    generation++
    flushController?.abort()
    pending = {}; pendingToken = null; latestChats = null; inFlightEntries = {}
    if (timer) { clearTimeout(timer); timer = null }
  }
  const session = generation, attempt = ++loadRevision
  const current = () => session === generation && attempt === loadRevision && token === getToken()
  hydrated = false
  if (loadTimer) { clearTimeout(loadTimer); loadTimer = null }
  reportState('loading')
  sessionToken = token
  // The previous workspace has been cleared/unmounted before an account switch.
  // The new account may still work locally if its server is temporarily offline.
  cleared = false
  const owner = origGet('nalu-data-owner')
  const saved = owner ? await idbGetAccountJournal(owner) : null
  if (!current()) return
  if (saved) {
    for (const [key, value] of Object.entries(saved.entries)) {
      if (key === 'nalu-chats' || value == null || origGet(key) !== null || SKIP.has(key)) continue
      try { origSet(key, value) } catch { /* full journal remains durable */ }
    }
    const full = await idbGetChats()
    if (!current()) return
    let restored = mergeChats(full, saved.chats || '[]')
    restored = mergeChats(restored, saved.entries['nalu-chats'] || '[]')
    restored = mergeChats(origGet('nalu-chats'), restored)
    if (!isEmptyish(restored)) {
      await idbSetChats(restored)
      if (!current()) return
      setChatsLocal(restored)
    }
    pendingToken = token
    pending = { ...saved.pending, ...pending }
    window.dispatchEvent(new Event('nalu-hydrated'))
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'load', token }),
      signal: controller.signal,
    })
    if (!res.ok || !current()) return
    const json = (await res.json()) as { data?: Record<string, unknown> }
    if (!current() || !json?.data || typeof json.data !== 'object' || Array.isArray(json.data)) return
    if (json.data) {
      const data = json.data
      const recovered = await recoverUnownedData(data)
      if (!current()) return
      // Merge tombstones FIRST so the chat/project merges below already exclude
      // everything the user deleted (on this or any other device).
      for (const k of ['nalu-deleted-chats', ...Object.values(PROJECT_COLLECTIONS), 'nalu-deleted-flows']) {
        if (data[k] != null) origSet(k, mergeIdList(origGet(k), typeof data[k] === 'string' ? (data[k] as string) : JSON.stringify(data[k])))
      }
      for (const [k, v] of Object.entries(data)) {
        if (k === BRAND_KEY && v === null && !Object.prototype.hasOwnProperty.call(pending, k)) { origRemove(k); continue }
        if (v == null || k === 'nalu-deleted-chats' || Object.values(PROJECT_COLLECTIONS).includes(k) || k === 'nalu-deleted-flows') continue
        if (!k.startsWith(PREFIX) || SKIP.has(k) || LOCAL_HYDRATE_SKIP.has(k)) continue
        const sv = typeof v === 'string' ? v : JSON.stringify(v)
        // Chats go through the quota-safe tier-down; everything else is small EXCEPT
        // regeneratable caches (e.g. nalu-logo-img-cache) which must NOT be allowed to
        // throw and abort the whole hydrate — skip them locally, they stay on the server.
        if (k === 'nalu-chats') {
          // The server holds the COMPLETE history. Write it to IndexedDB (durable, no
          // quota) FIRST so the UI can restore the full copy with every artifact — then a
          // slim first-paint copy to localStorage. Awaited so IDB is populated before the
          // 'nalu-hydrated' event below tells the UI to re-read it.
          const fullLocal = await idbGetChats()
          if (!current()) return
          let local = mergeChats(origGet(k), fullLocal || '[]')
          if (recovered.chats) local = mergeChats(local, recovered.chats)
          if (latestChats) local = mergeChats(latestChats, local)
          const merged = mergeChats(local, sv)
          await idbSetChats(merged)
          if (!current()) return
          setChatsLocal(merged)
        }
        else if (PROJECT_COLLECTIONS[k]) {
          const local = k === 'nalu-chat-projects' && recovered.projects ? mergeProjects(recovered.projects, origGet(k) || '[]', k) : origGet(k)
          origSet(k, mergeProjects(local, sv, k))
        }
        else if (k === BRAND_KEY && Object.prototype.hasOwnProperty.call(pending, k)) { /* keep this owner's unsent explicit selection */ }
        else { try { origSet(k, sv) } catch { /* oversized local cache — keep server copy, skip locally */ } }
      }
    }
    if (!current()) return
    loadDelay = 1200
    hydrated = true // server is now the confirmed source of truth — safe to sync
    cleared = false // a real session is loaded — persist flushes are safe again
    // Converge the server to the merged superset (in case local had unsynced items).
    // NOTE: 'nalu-chats' is deliberately EXCLUDED — the localStorage copy may be
    // artifact-stripped to fit quota, and pushing it here could overwrite the DB's
    // full studio artifacts. Chats sync only via pushChatsFull (complete payload).
    for (const k of [...Object.keys(PROJECT_COLLECTIONS), ...Object.values(PROJECT_COLLECTIONS), 'nalu-deleted-chats', 'nalu-deleted-flows']) {
      const v = origGet(k)
      if (v) schedule(k, v)
    }
    // localStorage now holds the (quota-fitted) history — tell the UI to re-read so a
    // session that mounted with an empty store shows its chats WITHOUT a manual reload.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('nalu-hydrated'))
    const completeChats = await idbGetChats()
    if (current() && completeChats && !isEmptyish(completeChats)) pushChatsFull(completeChats)
    if (current() && Object.keys(pending).length) { if (timer) clearTimeout(timer); timer = setTimeout(flush, 600) }
    else if (current()) reportState('saved')
  } catch {
    // offline / first run — proceed with whatever's local, but keep `hydrated`
    // false so we don't overwrite the server with a possibly-empty local state.
  } finally {
    clearTimeout(timeout)
    if (current() && !hydrated) {
      reportState('pending')
      loadTimer = setTimeout(() => { loadTimer = null; void loadFromServer() }, loadDelay)
      loadDelay = Math.min(30000, loadDelay * 2)
    }
  }
}

/** Clear synced data locally (on sign-out) so accounts don't bleed together. */
export async function clearLocal(): Promise<boolean> {
  if (!quarantineLegacyBrand()) return false
  const owner = origGet('nalu-data-owner')
  const archive: Record<string, string | null> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(PREFIX) && !SKIP.has(key)) archive[key] = origGet(key)
  }
  const outgoing = { ...inFlightEntries, ...pending, ...(latestChats ? { 'nalu-chats': latestChats } : {}) }
  Object.assign(archive, outgoing)
  generation++
  const clearingGeneration = generation
  loadRevision++
  hydrated = false
  cleared = true
  pending = {}
  inFlightEntries = {}
  pendingToken = null
  sessionToken = null
  retryDelay = 600
  loadDelay = 1200
  latestChats = null
  if (loadTimer) { clearTimeout(loadTimer); loadTimer = null }
  flushController?.abort()
  if (timer) { clearTimeout(timer); timer = null }
  // Sign-out removes access, not the owner's unsynced conversation history.
  // If the archive cannot commit, keep the old owner marker and active data;
  // prepareAccount will refuse a switch instead of assigning it to someone else.
  if (owner && !await idbArchiveAccount(owner, archive, outgoing)) {
    window.dispatchEvent(new Event('nalu-session-cleared'))
    reportState('error')
    return false
  }
  if (generation !== clearingGeneration || origGet('nalu-data-owner') !== owner) return false
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(PREFIX) && k !== 'nalu-token') keys.push(k)
  }
  for (const k of keys) origRemove(k)
  const clearedChats = idbClearChats()
  // Disarm syncing until the next successful hydrate: with localStorage now empty,
  // any collection write before we've re-loaded from the server would be a spurious
  // empty state we must NOT push (which is exactly how a fresh login lost history).
  window.dispatchEvent(new Event('nalu-session-cleared'))
  await clearedChats
  return true
}
