import { neon } from '@neondatabase/serverless'

// Reuse the connection across function invocations on warm Vercel instances.
// Neon serverless driver speaks HTTP, so this is cheap; the cache mainly
// avoids re-parsing the URL on every cold path.
let cached: ReturnType<typeof neon> | null = null

export function db(): ReturnType<typeof neon> {
  if (cached) return cached
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!url) throw new Error('Neon connection URL not set (DATABASE_URL or POSTGRES_URL)')
  cached = neon(url)
  return cached
}

let schemaPromise: Promise<void> | null = null

/** Idempotent table creation. Runs once per cold start; subsequent calls
 *  are no-ops thanks to IF NOT EXISTS. */
export async function ensureSchema(): Promise<void> {
  if (schemaPromise) return schemaPromise
  schemaPromise = (async () => {
    const sql = db()
    await sql`
      CREATE TABLE IF NOT EXISTS nalu_users (
        id              BIGINT       PRIMARY KEY,           -- GitHub user id
        login           TEXT         NOT NULL,
        name            TEXT,
        email           TEXT,
        avatar_url      TEXT,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        last_login_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        login_count     INTEGER      NOT NULL DEFAULT 1
      )
    `
    await sql`CREATE INDEX IF NOT EXISTS nalu_users_login_idx ON nalu_users (login)`
  })().catch((e) => {
    // If schema creation fails (perms / DB down), let later calls retry on
    // the next request rather than poisoning the cache permanently.
    schemaPromise = null
    throw e
  })
  return schemaPromise
}

export interface NaluUserRow {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
  created_at: string
  last_login_at: string
  login_count: number
}

export async function upsertGithubUser(input: {
  id: number
  login: string
  name?: string | null
  email?: string | null
  avatar_url?: string | null
}): Promise<NaluUserRow> {
  await ensureSchema()
  const sql = db()
  const rows = (await sql`
    INSERT INTO nalu_users (id, login, name, email, avatar_url)
    VALUES (${input.id}, ${input.login}, ${input.name ?? null}, ${input.email ?? null}, ${input.avatar_url ?? null})
    ON CONFLICT (id) DO UPDATE SET
      login         = EXCLUDED.login,
      name          = COALESCE(EXCLUDED.name, nalu_users.name),
      email         = COALESCE(EXCLUDED.email, nalu_users.email),
      avatar_url    = COALESCE(EXCLUDED.avatar_url, nalu_users.avatar_url),
      last_login_at = NOW(),
      login_count   = nalu_users.login_count + 1
    RETURNING id, login, name, email, avatar_url, created_at, last_login_at, login_count
  `) as unknown as NaluUserRow[]
  return rows[0]
}

export async function findUserById(id: number): Promise<NaluUserRow | null> {
  await ensureSchema()
  const sql = db()
  const rows = (await sql`SELECT id, login, name, email, avatar_url, created_at, last_login_at, login_count FROM nalu_users WHERE id = ${id}`) as unknown as NaluUserRow[]
  return rows[0] ?? null
}
