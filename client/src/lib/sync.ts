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

/** Patch localStorage so every `nalu-*` write is pushed to the server. */
export function installSync(): void {
  if (patched) return
  patched = true
  localStorage.setItem = (key: string, value: string) => {
    origSet(key, value)
    if (key.startsWith(PREFIX) && !SKIP.has(key)) schedule(key, value)
  }
  localStorage.removeItem = (key: string) => {
    origRemove(key)
    if (key.startsWith(PREFIX) && !SKIP.has(key)) schedule(key, null)
  }
}

/** Hydrate localStorage from the server (server is source of truth on login). */
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
        origSet(k, typeof v === 'string' ? v : JSON.stringify(v))
      }
    }
    hydrated = true // server is now the confirmed source of truth — safe to sync
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
