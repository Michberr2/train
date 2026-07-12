// Shared DB helpers for the Nalu API (Neon Postgres). Underscore-prefixed so
// Vercel does NOT turn this into a route — it's imported by the route handlers.
import { Client } from 'pg'
import crypto from 'node:crypto'

export function getClient(): Client {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL not set')
  const needsSsl = !/localhost|127\.0\.0\.1/.test(connectionString)
  return new Client({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  })
}

let schemaReady = false
export async function ensureSchema(client: Client): Promise<void> {
  if (schemaReady) return
  await client.query(`
    CREATE TABLE IF NOT EXISTS nalu_users (
      id           TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      salt         TEXT NOT NULL,
      hash         TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS nalu_sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS nalu_user_data (
      user_id    TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      value      JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, key)
    );
    -- AutoPilot task ledger: every unit of work Nalu does for a user, from any
    -- surface (CLI / desktop app, training flywheel, agent pipelines, voice,
    -- browser). The mobile AutoPilot screen reads this to show "everything you
    -- have ever done" plus live status. source ∈ cli|desktop|flywheel|pipeline|
    -- voice|browser|web; status ∈ queued|running|done|failed|cancelled.
    CREATE TABLE IF NOT EXISTS nalu_tasks (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      source     TEXT NOT NULL DEFAULT 'cli',
      title      TEXT NOT NULL,
      detail     TEXT,
      status     TEXT NOT NULL DEFAULT 'running',
      progress   REAL NOT NULL DEFAULT 0,
      events     JSONB NOT NULL DEFAULT '[]'::jsonb,
      meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS nalu_tasks_user_updated
      ON nalu_tasks (user_id, updated_at DESC);
  `)
  schemaReady = true
}

// PBKDF2 password hashing (matches the client's prior scheme; server-side now).
export function hashPassword(password: string, saltHex: string): string {
  const salt = Buffer.from(saltHex, 'hex')
  return crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256').toString('hex')
}
export function newSalt(): string {
  return crypto.randomBytes(16).toString('hex')
}
export function newToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

// Reads the bearer token from Authorization header or a `token` field.
export function readToken(req: { headers: Record<string, unknown>; body?: unknown }): string | null {
  const auth = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) as Record<string, unknown> | undefined
  const t = body?.token
  return typeof t === 'string' && t ? t : null
}
export function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}

export async function userIdForToken(client: Client, token: string | null): Promise<string | null> {
  if (!token) return null
  const r = await client.query('SELECT user_id FROM nalu_sessions WHERE token = $1', [token])
  return r.rows[0]?.user_id ?? null
}


// ---- Signed-in identity + learned profile (personalization everywhere) -----
export type UserIdentity = { id: string; name: string; profile: string }

/** Resolve who is calling (from the Bearer token) + their learned profile.
 *  Best-effort: returns null for anonymous or on any failure. */
export async function identityForRequest(req: { headers: Record<string, unknown>; body?: unknown }): Promise<UserIdentity | null> {
  const token = readToken(req)
  if (!token || !process.env.DATABASE_URL) return null
  const c = getClient()
  try {
    await c.connect()
    const u = await c.query(
      `SELECT u.id, u.display_name FROM nalu_sessions s JOIN nalu_users u ON u.id = s.user_id WHERE s.token = $1`,
      [token],
    )
    if (!u.rows.length) return null
    const id = String(u.rows[0].id)
    const name = String(u.rows[0].display_name || id.split('@')[0])
    let profile = ''
    try {
      const pr = await c.query('SELECT value FROM nalu_user_data WHERE user_id = $1 AND key = $2', [id, 'nalu-ai-profile'])
      if (pr.rows.length && typeof pr.rows[0].value === 'string') profile = pr.rows[0].value
    } catch { /* no profile yet */ }
    return { id, name, profile: profile.slice(0, 2000) }
  } catch {
    return null
  } finally {
    await c.end().catch(() => {})
  }
}

/** Persist the learned profile for a user. */
export async function saveProfile(userId: string, profile: string): Promise<void> {
  if (!process.env.DATABASE_URL) return
  const c = getClient()
  try {
    await c.connect()
    await c.query(
      `INSERT INTO nalu_user_data (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [userId, 'nalu-ai-profile', JSON.stringify(profile.slice(0, 2000))],
    )
  } catch { /* best-effort */ } finally {
    await c.end().catch(() => {})
  }
}

/** One personalization block usable in ANY engine's prompt. */
export function identityBlock(u: UserIdentity | null): string {
  if (!u) return ''
  // Profiles may arrive as plain text, a JSON-quoted string, or (from an over-
  // eager model) a JSON object — normalize ALL of them to plain text.
  let profile = (u.profile || '').trim()
  try {
    const parsed = JSON.parse(profile) as unknown
    if (typeof parsed === 'string') profile = parsed.trim()
    else if (parsed && typeof parsed === 'object')
      profile = String(Object.values(parsed as Record<string, unknown>).find((v) => typeof v === 'string') || '').trim()
  } catch { /* already plain text */ }
  return `\n\nSIGNED-IN USER: ${u.name}. Address them by name where natural, and personalize to them.${profile ? `\nWHAT YOU HAVE LEARNED ABOUT ${u.name.toUpperCase()} (use for personalization; never recite wholesale): ${profile}` : ''}`
}
