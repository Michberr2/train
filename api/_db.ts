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
