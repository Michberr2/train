import { connectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { reserveCloudflareQuota } from './_cloudflareQuota'
// Per-subject daily usage caps for paid/limited features (video, …). Keeps a
// viral spike from running up a surprise bill. Keyed by signed-in user when a
// token is present, else by client IP for anonymous visitors.
//
// HARD RULE: fail OPEN. If the DB is unavailable or anything throws, allow the
// request — a metering outage must never take video down.
import { getClient, readToken, userIdForToken } from './_db'
import crypto from 'node:crypto'

const USAGE_DDL = `CREATE TABLE IF NOT EXISTS nalu_usage (
  subject TEXT NOT NULL,
  day     DATE NOT NULL,
  kind    TEXT NOT NULL,
  count   INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day, kind)
)`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clientIp(req: any): string {
  const xf = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  return xf || String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown')
}

// Anonymous subject key. Keying purely on IP means everyone behind one corporate/
// campus/carrier NAT shares a single daily bucket. So prefer a stable per-device
// id the client sends (X-Nalu-Device / nalu_did cookie), and otherwise fold the
// user-agent + language into the IP hash so distinct devices on the same IP get
// distinct buckets (only truly-identical clients still collide).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anonSubject(req: any): string {
  const h = req?.headers || {}
  const dev = String(h['x-nalu-device'] || '').trim()
  if (dev) return `dev:${dev.slice(0, 64)}`
  const cookie = String(h['cookie'] || '')
  const m = cookie.match(/(?:^|;\s*)nalu_did=([^;]+)/)
  if (m) return `dev:${decodeURIComponent(m[1]).slice(0, 64)}`
  const ua = String(h['user-agent'] || '')
  const lang = String(h['accept-language'] || '')
  const hash = crypto.createHash('sha256').update(`${clientIp(req)}|${ua}|${lang}`).digest('hex').slice(0, 16)
  return `ipd:${hash}`
}

function intEnv(name: string, dflt: number): number {
  const v = process.env[name]
  const n = v ? parseInt(v, 10) : NaN
  return Number.isFinite(n) ? n : dflt
}

export type QuotaResult = {
  ok: boolean
  used: number
  limit: number
  signedIn: boolean
  /** Refund the reserved slot — call if the work ultimately failed. No-op when not reserved. */
  release: () => Promise<void>
}

/**
 * Reserve one unit of today's quota for `kind`. Atomically increments the
 * counter and rejects if it would exceed the limit (with a compensating
 * decrement). Anonymous and signed-in users get separate, env-tunable limits;
 * a limit <= 0 means unlimited.
 */
export async function reserveDailyQuota(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: any,
  kind: string,
  opts?: { anonPerDay?: number; userPerDay?: number },
): Promise<QuotaResult> {
  const noop = async () => {}
  const anonLimit = opts?.anonPerDay ?? intEnv('NALU_FREE_VIDEO_PER_DAY', 3)
  const userLimit = opts?.userPerDay ?? intEnv('NALU_USER_VIDEO_PER_DAY', 25)

  if (process.env.NALU_STORAGE_BACKEND === 'cloudflare') {
    try {
      const backend = connectionBackend(), uid = await backend.userId(readToken(req)), signedIn = !!uid
      const limit = signedIn ? userLimit : anonLimit
      if (limit <= 0) return { ok: true, used: 0, limit: 0, signedIn, release: noop }
      const quota = await reserveCloudflareQuota(backend.client as CloudflareStore, uid ? `user:${uid}` : anonSubject(req), kind, limit)
      return { ...quota, signedIn }
    } catch { return { ok: true, used: 0, limit: 0, signedIn: false, release: noop } }
  }
  let client
  try {
    client = getClient()
  } catch {
    // No DATABASE_URL configured → metering off, allow.
    return { ok: true, used: 0, limit: 0, signedIn: false, release: noop }
  }

  try {
    await client.connect()
    await client.query(USAGE_DDL)

    let subject = anonSubject(req)
    let signedIn = false
    try {
      const uid = await userIdForToken(client, readToken(req))
      if (uid) {
        subject = `user:${uid}`
        signedIn = true
      }
    } catch {
      /* anonymous */
    }

    const limit = signedIn ? userLimit : anonLimit
    if (limit <= 0) {
      await client.end().catch(() => {})
      return { ok: true, used: 0, limit: 0, signedIn, release: noop }
    }

    // Atomic reserve: increment today's counter and read the new value.
    const r = await client.query(
      `INSERT INTO nalu_usage (subject, day, kind, count)
       VALUES ($1, CURRENT_DATE, $2, 1)
       ON CONFLICT (subject, day, kind) DO UPDATE SET count = nalu_usage.count + 1
       RETURNING count`,
      [subject, kind],
    )
    const used = (r.rows[0]?.count as number) ?? 1

    if (used > limit) {
      // Over the cap — give the slot back and reject.
      await client
        .query(
          `UPDATE nalu_usage SET count = GREATEST(count - 1, 0) WHERE subject = $1 AND day = CURRENT_DATE AND kind = $2`,
          [subject, kind],
        )
        .catch(() => {})
      await client.end().catch(() => {})
      return { ok: false, used: used - 1, limit, signedIn, release: noop }
    }

    // Reserved. Hand back a release() that refunds the slot on downstream failure.
    // Retry a few times: a transient DB blip must NOT permanently burn a slot the
    // user never got value from (esp. the low anon video limit).
    let released = false
    const release = async () => {
      if (released) return // idempotent — safe to call on multiple failure paths
      for (let i = 0; i < 3; i++) {
        const c = getClient()
        try {
          await c.connect()
          await c.query(
            `UPDATE nalu_usage SET count = GREATEST(count - 1, 0) WHERE subject = $1 AND day = CURRENT_DATE AND kind = $2`,
            [subject, kind],
          )
          released = true
          await c.end().catch(() => {})
          return
        } catch {
          await c.end().catch(() => {})
          await new Promise((r) => setTimeout(r, 200 * (i + 1)))
        }
      }
    }
    await client.end().catch(() => {})
    return { ok: true, used, limit, signedIn, release }
  } catch {
    // Any DB error → fail open.
    try {
      await client.end()
    } catch {
      /* ignore */
    }
    return { ok: true, used: 0, limit: 0, signedIn: false, release: noop }
  }
}

/**
 * Daily quota for a Studio LLM artifact (doc/sheet/slides/cad/design) — generous
 * limits so real users never feel it, but a cap so a traffic spike (or abuse)
 * can't run up the bill. Tunable via NALU_FREE_STUDIO_PER_DAY / NALU_USER_STUDIO_PER_DAY.
 * Fails open if metering is unavailable.
 */
export async function reserveStudioQuota(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: any,
  kind: string,
): Promise<QuotaResult> {
  return reserveDailyQuota(req, kind, {
    anonPerDay: intEnv('NALU_FREE_STUDIO_PER_DAY', 40),
    userPerDay: intEnv('NALU_USER_STUDIO_PER_DAY', 400),
  })
}

/** A user-facing "you hit the limit" message for a Studio artifact. */
export function studioLimitMessage(noun: string, q: QuotaResult): string {
  return q.signedIn
    ? `You've reached today's ${noun} limit (${q.limit}/day). It resets tomorrow.`
    : `Free ${noun} limit reached (${q.limit}/day). Sign in for more, or try again tomorrow.`
}
