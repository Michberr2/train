import { connectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { reserveCloudflareQuota } from './_cloudflareQuota'
// Per-subject daily usage caps for paid/limited features (video, …). Keeps a
// viral spike from running up a surprise bill. Keyed by signed-in user when a
// token is present, else by client IP for anonymous visitors.
//
// Metering is required before paid provider work. A storage outage returns a
// retryable unavailable result; it never silently disables spending controls.
import { getClient, readToken, userIdForToken } from './_db'
import crypto from 'node:crypto'
import { isIP } from 'node:net'
import { recordSwarmStudioQuota, registerSwarmStudioHook, swarmStudioInvocation } from './_swarmStudioContext'

registerSwarmStudioHook('quota')

const USAGE_DDL = `CREATE TABLE IF NOT EXISTS nalu_usage (
  subject TEXT NOT NULL,
  day     DATE NOT NULL,
  kind    TEXT NOT NULL,
  count   INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day, kind)
);
CREATE TABLE IF NOT EXISTS nalu_usage_reservations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  day DATE NOT NULL,
  kind TEXT NOT NULL,
  released BOOLEAN NOT NULL DEFAULT FALSE
)`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clientIp(req: any): string {
  // Vercel overwrites forwarded-for at its trusted edge. Outside Vercel, a
  // caller-supplied forwarding header is not an identity (local adapters use
  // the socket address). https://vercel.com/docs/headers/request-headers
  const forwarded = process.env.VERCEL === '1' ? String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() : ''
  const address = forwarded || String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '')
  return isIP(address) ? address.toLowerCase() : 'unknown'
}

// Guests share a network bucket. Device IDs, cookies, language and user-agent
// are client-controlled and must not mint fresh paid-generation allowances.
// Signed-in users keep their separate account allowance, including on a NAT.
function anonSubject(req: any): string {
  const hash = crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 32)
  return `ip:${hash}`
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
  status?: 429 | 503
  reason?: 'limit' | 'unavailable'
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
  const unavailable = (): QuotaResult => ({ ok: false, used: 0, limit: 0, signedIn: false, status: 503, reason: 'unavailable', release: noop })
  const anonLimit = Number.isFinite(opts?.anonPerDay) ? opts!.anonPerDay! : intEnv('NALU_FREE_VIDEO_PER_DAY', 3)
  const userLimit = Number.isFinite(opts?.userPerDay) ? opts!.userPerDay! : intEnv('NALU_USER_VIDEO_PER_DAY', 25)

  if (process.env.NALU_STORAGE_BACKEND === 'cloudflare') {
    try {
      const backend = connectionBackend(), uid = swarmStudioInvocation()?.ownerId ?? await backend.userId(readToken(req)), signedIn = !!uid
      const limit = signedIn ? userLimit : anonLimit
      if (limit <= 0) return recordSwarmStudioQuota(uid, kind, { ok: true, used: 0, limit: 0, signedIn, release: noop })
      const quota = await reserveCloudflareQuota(backend.client as CloudflareStore, uid ? `user:${uid}` : anonSubject(req), kind, limit)
      return recordSwarmStudioQuota(uid, kind, { ...quota, signedIn, ...(!quota.ok ? { status: 429 as const, reason: 'limit' as const } : {}) })
    } catch { return unavailable() }
  }
  let client
  try {
    client = getClient()
  } catch {
    return unavailable()
  }

  try {
    await client.connect()
    await client.query(USAGE_DDL)

    const uid = swarmStudioInvocation()?.ownerId ?? await userIdForToken(client, readToken(req))
    const subject = uid ? `user:${uid}` : anonSubject(req)
    const signedIn = !!uid

    const limit = signedIn ? userLimit : anonLimit
    if (limit <= 0) {
      await client.end().catch(() => {})
      return recordSwarmStudioQuota(uid, kind, { ok: true, used: 0, limit: 0, signedIn, release: noop })
    }

    // Counter and durable receipt commit together. The conditional upsert
    // never increments past the cap, so denied requests need no refund.
    await client.query('BEGIN')
    const r = await client.query(
      `INSERT INTO nalu_usage (subject, day, kind, count)
       VALUES ($1, CURRENT_DATE, $2, 1)
       ON CONFLICT (subject, day, kind) DO UPDATE SET count = nalu_usage.count + 1
       WHERE nalu_usage.count < $3
       RETURNING count, day::text AS quota_day`,
      [subject, kind, limit],
    )
    if (!r.rows.length) {
      await client.query('ROLLBACK')
      await client.end().catch(() => {})
      return recordSwarmStudioQuota(uid, kind, { ok: false, used: limit, limit, signedIn, status: 429 as const, reason: 'limit' as const, release: noop })
    }
    const used = Number(r.rows[0]?.count)
    const quotaDay = String(r.rows[0]?.quota_day || '')
    if (!Number.isFinite(used) || used < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(quotaDay)) throw new Error('Usage reservation was not confirmed.')
    const reservationId = crypto.randomUUID()
    await client.query('INSERT INTO nalu_usage_reservations(id,subject,day,kind) VALUES ($1,$2,$3::date,$4)', [reservationId, subject, quotaDay, kind])
    await client.query('COMMIT')

    // Reserved. Hand back a release() that refunds the slot on downstream failure.
    // Retry a few times: a transient DB blip must NOT permanently burn a slot the
    // user never got value from (esp. the low anon video limit).
    let released = false
    let refunding: Promise<void> | undefined
    const refund = async () => {
      if (released) return
      for (let i = 0; i < 3; i++) {
        const c = getClient()
        try {
          await c.connect()
          await c.query('BEGIN')
          // This receipt claim and the decrement are one transaction. Retrying
          // after a lost COMMIT acknowledgement cannot refund another task.
          const claimed = await c.query('UPDATE nalu_usage_reservations SET released=TRUE WHERE id=$1 AND released=FALSE RETURNING id', [reservationId])
          if (claimed.rows.length) await c.query(
            `UPDATE nalu_usage SET count = GREATEST(count - 1, 0) WHERE subject = $1 AND day = $3::date AND kind = $2`,
            [subject, kind, quotaDay],
          )
          await c.query('COMMIT')
          released = true
          return
        } catch {
          await c.query('ROLLBACK').catch(() => {})
          if (i < 2) await new Promise(resolve => setTimeout(resolve, 200 * (i + 1)))
        } finally { await c.end().catch(() => {}) }
      }
      throw new Error('Usage refund is temporarily unavailable. Please retry cleanup.')
    }
    const release = () => refunding ||= refund().finally(() => { refunding = undefined })
    await client.end().catch(() => {})
    return recordSwarmStudioQuota(uid, kind, { ok: true, used, limit, signedIn, release })
  } catch {
    // The provider is never invoked without a confirmed allowance.
    try {
      await client.query('ROLLBACK').catch(() => {})
      await client.end()
    } catch {
      /* ignore */
    }
    return unavailable()
  }
}

/**
 * Daily quota for a Studio LLM artifact (doc/sheet/slides/cad/design) — generous
 * limits so real users never feel it, but a cap so a traffic spike (or abuse)
 * can't run up the bill. Tunable via NALU_FREE_STUDIO_PER_DAY / NALU_USER_STUDIO_PER_DAY.
 * Fails closed with a retryable 503 if metering is unavailable.
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
  if (q.reason === 'unavailable') return 'Usage checks are temporarily unavailable. Please retry in a moment; generation has not started.'
  return q.signedIn
    ? `You've reached today's ${noun} limit (${q.limit}/day). It resets tomorrow.`
    : `Free ${noun} limit reached (${q.limit}/day). Sign in for more, or try again tomorrow.`
}
