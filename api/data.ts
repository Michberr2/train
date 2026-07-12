// Nalu per-user data store (Neon Postgres). Mirrors the Dashboard's `nalu-*`
// localStorage keys so conversations, projects, plugins, automations, GitHub
// PAT, settings, etc. persist server-side and sync across n4lu.ai/.com + devices.
// POST { action: 'load'|'set'|'setMany'|'remove', token, ... }
import { runDueCrons } from './_cron'
import { getClient, ensureSchema, userIdForToken, readToken, safeJson, newToken } from './_db'

const SHARE_DDL =
  'CREATE TABLE IF NOT EXISTS nalu_shares (id TEXT PRIMARY KEY, html TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())'

// The message fields that hold generated Studio work. If an incoming save is
// missing one that the stored copy still has, we RESTORE it — the DB never
// drops a doc/sheet/deck/design/video, even if a client sends a slimmed payload.
const ARTIFACT_FIELDS = ['doc', 'sheet', 'deck', 'design', 'cad', 'video', 'image']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

// Merge an incoming chats array with what's already stored so that NO generated
// artifact (or non-empty answer text) is ever lost. Deletions are still honored
// — a chat absent from `incoming` is dropped — but any chat that survives keeps
// every artifact it ever had.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function preserveChatArtifacts(incoming: any, stored: any): any {
  if (!Array.isArray(incoming) || !Array.isArray(stored) || !stored.length) return incoming
  const storedById = new Map<string, AnyObj>()
  for (const c of stored) if (c && c.id) storedById.set(String(c.id), c)
  return incoming.map((chat: AnyObj) => {
    const old = chat && chat.id ? storedById.get(String(chat.id)) : null
    if (!old || !Array.isArray(old.messages) || !Array.isArray(chat.messages)) return chat
    const oldMsgs: AnyObj[] = old.messages
    const messages = chat.messages.map((m: AnyObj, i: number) => {
      const om = oldMsgs[i]
      if (!om || om.role !== m.role) return m
      const out: AnyObj = { ...m }
      for (const f of ARTIFACT_FIELDS) if (out[f] == null && om[f] != null) out[f] = om[f]
      if ((!out.content || String(out.content).length === 0) && om.content) out.content = om.content
      if (out.reasoning == null && om.reasoning != null) out.reasoning = om.reasoning
      return out
    })
    // if the incoming chat somehow has FEWER messages, append the stored tail
    if (oldMsgs.length > chat.messages.length) messages.push(...oldMsgs.slice(chat.messages.length))
    return { ...chat, messages }
  })
}

const asArray = (v: unknown): AnyObj[] | null => {
  if (Array.isArray(v)) return v as AnyObj[]
  if (typeof v === 'string') { const p = safeJson(v); return Array.isArray(p) ? p : null }
  return null
}

// Turn the user's stored chats into AutoPilot "activity" items (same shape as a
// task row) so the phone shows everything they've ever made — conversations plus
// every Studio artifact (docs, sheets, decks, sites, videos, CAD, images).
const STUDIO_KIND: Record<string, string> = {
  doc: 'Document', deck: 'Presentation', sheet: 'Spreadsheet',
  design: 'Website', video: 'Video', cad: 'CAD model', image: 'Image',
}
function deriveChatActivity(chatsVal: unknown): AnyObj[] {
  const chats = asArray(chatsVal)
  if (!chats) return []
  const items: AnyObj[] = []
  for (const c of chats.slice(0, 500)) {
    if (!c || !Array.isArray(c.messages)) continue
    const kinds: string[] = []
    let lastUser = ''
    for (const m of c.messages as AnyObj[]) {
      if (!m) continue
      if (m.role === 'user' && typeof m.content === 'string' && m.content) lastUser = m.content
      for (const f of ARTIFACT_FIELDS) if (m[f] != null && !kinds.includes(f)) kinds.push(f)
    }
    const labels = kinds.map((k) => STUDIO_KIND[k] || k)
    const ts = Number(c.createdAt) || 0
    const iso = ts ? new Date(ts).toISOString() : new Date(0).toISOString()
    items.push({
      id: `chat_${c.id}`,
      source: labels.length ? 'studio' : 'chat',
      title: String(c.title || 'New chat').slice(0, 300),
      detail: labels.length ? labels.join(' · ') : (lastUser ? lastUser.slice(0, 160) : 'Conversation'),
      status: 'done',
      progress: 1,
      events: [],
      meta: { kind: 'chat', artifacts: labels, count: (c.messages as AnyObj[]).length },
      created_at: iso,
      updated_at: iso,
    })
  }
  return items
}

// Read a stored id-array (e.g. a tombstone list) as a Set of strings.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readIdSet(client: any, userId: string, key: string): Promise<Set<string>> {
  const r = await client.query('SELECT value FROM nalu_user_data WHERE user_id = $1 AND key = $2', [userId, key])
  const arr = asArray(r.rows[0]?.value) || []
  return new Set(arr.map((x) => String((x as AnyObj)?.id ?? x)))
}

async function writeGuarded(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any, userId: string, key: string, value: unknown,
): Promise<void> {
  let toWrite = value

  // Tombstone lists are APPEND-ONLY: union incoming with what's stored so a
  // delete can NEVER be undone by a stale client that lacks the tombstone.
  if (key === 'nalu-deleted-chats' || key === 'nalu-deleted-projects') {
    const incoming = (asArray(value) || []).map((x) => String((x as AnyObj)?.id ?? x))
    const stored = [...(await readIdSet(client, userId, key))]
    const union = Array.from(new Set([...stored, ...incoming]))
    toWrite = typeof value === 'string' ? JSON.stringify(union) : union
  }

  // Chats: preserve artifacts AND enforce tombstones — a chat the user deleted
  // is never re-stored, even if a stale device re-uploads it.
  else if (key === 'nalu-chats') {
    const incoming = asArray(value) // sync sends a JSON STRING; 'set' may send an array
    if (incoming) {
      const prev = await client.query('SELECT value FROM nalu_user_data WHERE user_id = $1 AND key = $2', [userId, key])
      const stored = asArray(prev.rows[0]?.value)
      let merged = stored ? preserveChatArtifacts(incoming, stored) : incoming
      const dead = await readIdSet(client, userId, 'nalu-deleted-chats')
      if (dead.size) merged = (merged as AnyObj[]).filter((c) => !dead.has(String(c?.id)))
      toWrite = typeof value === 'string' ? JSON.stringify(merged) : merged
    }
  }

  // Projects: enforce the project tombstones the same way.
  else if (key === 'nalu-chat-projects') {
    const incoming = asArray(value)
    if (incoming) {
      const dead = await readIdSet(client, userId, 'nalu-deleted-projects')
      const filtered = dead.size ? incoming.filter((p) => !dead.has(String((p as AnyObj)?.id))) : incoming
      toWrite = typeof value === 'string' ? JSON.stringify(filtered) : filtered
    }
  }

  await client.query(
    `INSERT INTO nalu_user_data (user_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [userId, key, JSON.stringify(toWrite ?? null)],
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  // Public GET — serve a shared website by id, no auth (a clickable share link).
  if (req.method === 'GET') {
    const id = String((req.query && req.query.share) || '').replace(/[^a-zA-Z0-9_-]/g, '')
    if (!id) {
      res.status(400).send('Missing share id')
      return
    }
    const c = getClient()
    try {
      await c.connect()
      await c.query(SHARE_DDL)
      const r = await c.query('SELECT html FROM nalu_shares WHERE id = $1', [id])
      if (!r.rows.length) {
        res.status(404).send('This Nalu site was not found.')
        return
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'public, max-age=600')
      res.status(200).send(r.rows[0].html)
    } catch {
      res.status(500).send('Error loading site.')
    } finally {
      await c.end().catch(() => {})
    }
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}
  const action = String(body.action || '')

  const client = getClient()
  try {
    await client.connect()
    await ensureSchema(client)

    // Server-side AutoPilot scheduler (Vercel Cron / GitHub Action) — runs DUE
    // flows even when nobody has the site open. Authed by CRON_SECRET, not a user
    // token, so it's handled before the normal auth below.
    const reqAny = req as unknown as { query?: Record<string, unknown>; url?: string; headers: Record<string, string | string[] | undefined> }
    const isCron = action === 'cron' || String(reqAny.query?.action || '') === 'cron' || String(reqAny.url || '').includes('action=cron')
    if (isCron) {
      const secret = process.env.CRON_SECRET
      if (secret && reqAny.headers['authorization'] !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' })
      const r = await runDueCrons(client)
      return res.status(200).json({ ok: true, ...r, at: new Date().toISOString() })
    }

    const userId = await userIdForToken(client, readToken(req))
    if (!userId) return res.status(401).json({ error: 'not authenticated' })

    // Publish a generated website and get a shareable link.
    if (action === 'share') {
      const html = String(body.html || '')
      if (!html) return res.status(400).json({ error: 'html required' })
      await client.query(SHARE_DDL)
      const id = newToken().slice(0, 14)
      await client.query('INSERT INTO nalu_shares (id, html) VALUES ($1, $2)', [id, html.slice(0, 800000)])
      return res.status(200).json({ ok: true, id, url: `/api/data?share=${id}` })
    }

    if (action === 'load') {
      const r = await client.query('SELECT key, value FROM nalu_user_data WHERE user_id = $1', [userId])
      const data: Record<string, unknown> = {}
      for (const row of r.rows) data[row.key] = row.value
      return res.status(200).json({ data })
    }

    if (action === 'set') {
      const key = String(body.key || '')
      if (!key) return res.status(400).json({ error: 'key required' })
      await writeGuarded(client, userId, key, body.value ?? null)
      return res.status(200).json({ ok: true })
    }

    if (action === 'setMany') {
      const entries = (body.entries && typeof body.entries === 'object' ? body.entries : {}) as Record<string, unknown>
      const keys = Object.keys(entries)
      for (const key of keys) {
        await writeGuarded(client, userId, key, entries[key] ?? null)
      }
      return res.status(200).json({ ok: true, count: keys.length })
    }

    if (action === 'remove') {
      const key = String(body.key || '')
      if (key) await client.query('DELETE FROM nalu_user_data WHERE user_id = $1 AND key = $2', [userId, key])
      return res.status(200).json({ ok: true })
    }

    // ---- AutoPilot task ledger (per-user) -----------------------------------
    // task-log: create OR update a task. Any surface (CLI/desktop, flywheel,
    // pipeline, voice, browser) calls this with the SAME id to append progress.
    // Everything is scoped to this token's user — a task id from another user is
    // never touched (ON CONFLICT ... WHERE user_id = caller).
    if (action === 'task-log') {
      const id = String(body.id || '') || `t_${newToken().slice(0, 18)}`
      const source = String(body.source || 'cli').slice(0, 24)
      const title = String(body.title || '').slice(0, 300)
      const detail = body.detail != null ? String(body.detail).slice(0, 4000) : null
      const status = body.status != null ? String(body.status).slice(0, 24) : null
      const progress = body.progress != null ? Math.max(0, Math.min(1, Number(body.progress) || 0)) : null
      const event = body.event != null ? String(body.event).slice(0, 500) : null
      const meta = body.meta && typeof body.meta === 'object' ? JSON.stringify(body.meta) : null
      const r = await client.query(
        `INSERT INTO nalu_tasks (id, user_id, source, title, detail, status, progress, events, meta, updated_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6,'running'), COALESCE($7::real,0),
                 CASE WHEN $8::text IS NULL THEN '[]'::jsonb
                      ELSE jsonb_build_array(jsonb_build_object('t', NOW(), 'm', $8::text)) END,
                 COALESCE($9::jsonb,'{}'::jsonb), NOW())
         ON CONFLICT (id) DO UPDATE SET
           source     = COALESCE(EXCLUDED.source, nalu_tasks.source),
           title      = CASE WHEN $4 <> '' THEN EXCLUDED.title ELSE nalu_tasks.title END,
           detail     = COALESCE($5, nalu_tasks.detail),
           status     = COALESCE($6, nalu_tasks.status),
           progress   = COALESCE($7::real, nalu_tasks.progress),
           events     = CASE WHEN $8::text IS NULL THEN nalu_tasks.events
                             ELSE nalu_tasks.events || jsonb_build_array(jsonb_build_object('t', NOW(), 'm', $8::text)) END,
           meta       = nalu_tasks.meta || COALESCE($9::jsonb,'{}'::jsonb),
           updated_at = NOW()
         WHERE nalu_tasks.user_id = $2
         RETURNING id, source, title, detail, status, progress, events, meta, created_at, updated_at`,
        [id, userId, source, title, detail, status, progress, event, meta],
      )
      return res.status(200).json({ ok: true, task: r.rows[0] ?? { id } })
    }

    // activity: the FULL AutoPilot picture — the live task ledger PLUS everything
    // this user has ever made in chat (conversations + Studio docs/sheets/decks/
    // sites/videos/CAD/images), unified and newest-first. Used for the initial
    // load and pull-to-refresh; live polling uses task-feed for ledger deltas.
    if (action === 'activity') {
      const tRes = await client.query(
        `SELECT id, source, title, detail, status, progress, events, meta, created_at, updated_at
           FROM nalu_tasks WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 300`,
        [userId],
      )
      const chatRes = await client.query(
        'SELECT value FROM nalu_user_data WHERE user_id = $1 AND key = $2',
        [userId, 'nalu-chats'],
      )
      const chatItems = deriveChatActivity(chatRes.rows[0]?.value)
      return res.status(200).json({ tasks: tRes.rows, chats: chatItems, now: new Date().toISOString() })
    }

    // task-feed: the AutoPilot history — every task for this user, newest first.
    // Pass `since` (ISO) to poll only what changed (real-time updates).
    if (action === 'task-feed') {
      const since = body.since ? String(body.since) : null
      const limit = Math.max(1, Math.min(500, Number(body.limit) || 200))
      const r = await client.query(
        `SELECT id, source, title, detail, status, progress, events, meta, created_at, updated_at
           FROM nalu_tasks
          WHERE user_id = $1 AND ($2::timestamptz IS NULL OR updated_at > $2::timestamptz)
          ORDER BY updated_at DESC
          LIMIT $3`,
        [userId, since, limit],
      )
      return res.status(200).json({ tasks: r.rows, now: new Date().toISOString() })
    }

    // task-clear: remove one task (id) or all of this user's finished tasks.
    if (action === 'task-clear') {
      const id = String(body.id || '')
      if (id) await client.query('DELETE FROM nalu_tasks WHERE user_id = $1 AND id = $2', [userId, id])
      else await client.query(`DELETE FROM nalu_tasks WHERE user_id = $1 AND status IN ('done','failed','cancelled')`, [userId])
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: 'unknown action' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return res.status(500).json({ error: message })
  } finally {
    await client.end().catch(() => {})
  }
}
