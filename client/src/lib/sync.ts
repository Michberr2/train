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

const PREFIX = 'nalu-'
const SKIP = new Set(['nalu-token']) // never sync the session token

let patched = false
let hydrated = false // true once the server load has succeeded this session
let pending: Record<string, string | null> = {}
let timer: ReturnType<typeof setTimeout> | null = null

// Collection keys we must NEVER clobber with an empty value before we've
// successfully hydrated from the server — otherwise a transient network failure
// on load could overwrite real chats/projects with "[]".
const COLLECTIONS = new Set(['nalu-chats', 'nalu-chat-projects'])
const isEmptyish = (v: string | null) => v == null || v === '[]' || v === '{}' || v === '' || v === 'null'

// Original (unpatched) accessors so hydration/flush don't re-trigger sync.
const origSet = localStorage.setItem.bind(localStorage)
const origRemove = localStorage.removeItem.bind(localStorage)

async function flush(): Promise<void> {
  const token = getToken()
  if (!token) return
  const entries = pending
  pending = {}
  if (!Object.keys(entries).length) return
  try {
    await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'setMany', token, entries }),
    })
  } catch {
    // best-effort; will resync on next change
  }
}

function schedule(key: string, value: string | null): void {
  // Guard: don't push an empty chats/projects value to the server until we've
  // confirmed (via a successful hydrate) that empty is the real state.
  if (!hydrated && COLLECTIONS.has(key) && isEmptyish(value)) return
  pending[key] = value
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
  if (!hydrated && isEmptyish(fullJson)) return
  schedule('nalu-chats', fullJson)
}

export function installSync(): void {
  installApiAuth()
  if (patched) return
  patched = true
  localStorage.setItem = (key: string, value: string) => {
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
function mergeChats(localStr: string | null, serverStr: string): string {
  const byId = new Map<string, Record<string, unknown>>()
  for (const c of safeArr(serverStr)) if (c && c.id) byId.set(String(c.id), c)
  for (const c of safeArr(localStr)) {
    if (!c || !c.id) continue
    const ex = byId.get(String(c.id))
    const lm = Array.isArray(c.messages) ? c.messages.length : 0
    const em = ex && Array.isArray(ex.messages) ? ex.messages.length : -1
    if (!ex || lm >= em) byId.set(String(c.id), c) // local (usually newer) wins ties
  }
  const merged = [...byId.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
  return JSON.stringify(merged)
}
function mergeProjects(localStr: string | null, serverStr: string): string {
  const byId = new Map<string, Record<string, unknown>>()
  for (const p of safeArr(serverStr)) if (p && p.id) byId.set(String(p.id), p)
  for (const p of safeArr(localStr)) if (p && p.id) byId.set(String(p.id), p) // local wins (renames)
  return JSON.stringify([...byId.values()])
}

/** Hydrate localStorage from the server, MERGING chats/projects so nothing is lost. */
export async function loadFromServer(): Promise<void> {
  const token = getToken()
  if (!token) return
  try {
    const res = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'load', token }),
    })
    const json = (await res.json()) as { data?: Record<string, unknown> }
    if (json?.data && typeof json.data === 'object') {
      for (const [k, v] of Object.entries(json.data)) {
        if (v == null) continue
        const sv = typeof v === 'string' ? v : JSON.stringify(v)
        if (k === 'nalu-chats') origSet(k, mergeChats(origGet(k), sv))
        else if (k === 'nalu-chat-projects') origSet(k, mergeProjects(origGet(k), sv))
        else origSet(k, sv)
      }
    }
    hydrated = true // server is now the confirmed source of truth — safe to sync
    // Converge the server to the merged superset (in case local had unsynced chats).
    for (const k of ['nalu-chats', 'nalu-chat-projects']) {
      const v = origGet(k)
      if (v) schedule(k, v)
    }
  } catch {
    // offline / first run — proceed with whatever's local, but keep `hydrated`
    // false so we don't overwrite the server with a possibly-empty local state.
  }
}

/** Clear synced data locally (on sign-out) so accounts don't bleed together. */
export function clearLocal(): void {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(PREFIX) && !SKIP.has(k)) keys.push(k)
  }
  for (const k of keys) origRemove(k)
}
