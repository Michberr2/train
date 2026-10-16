import { randomUUID } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'

export async function reserveCloudflareQuota(store: CloudflareStore, subject: string, kind: string, limit: number) {
  const id = randomUUID(), day = new Date().toISOString().slice(0, 10)
  const result = await store.batch([
    { sql: 'INSERT INTO nalu_usage(subject,day,kind,count) VALUES(?,?,?,0) ON CONFLICT DO NOTHING', params: [subject, day, kind] },
    { sql: `INSERT INTO nalu_usage_reservations(id,subject,day,kind) SELECT ?,subject,day,kind FROM nalu_usage
      WHERE subject=? AND day=? AND kind=? AND count<? ON CONFLICT(id) DO NOTHING`, params: [id, subject, day, kind, limit] },
    { sql: `UPDATE nalu_usage SET count=count+1 WHERE subject=? AND day=? AND kind=?
      AND EXISTS(SELECT 1 FROM nalu_usage_reservations WHERE id=? AND counted=0)`, params: [subject, day, kind, id] },
    { sql: 'UPDATE nalu_usage_reservations SET counted=1 WHERE id=? RETURNING id', params: [id] },
    { sql: 'SELECT count FROM nalu_usage WHERE subject=? AND day=? AND kind=?', params: [subject, day, kind] },
  ])
  const ok = !!result.results[3].results.length, used = Number(result.results[4].results[0].count)
  const release = async () => {
    if (!ok) return
    // Refund and receipt publication are atomic. Repeating this after a lost
    // acknowledgement cannot consume somebody else's quota reservation.
    await store.batch([
      { sql: `UPDATE nalu_usage SET count=MAX(count-1,0) WHERE subject=? AND day=? AND kind=?
        AND EXISTS(SELECT 1 FROM nalu_usage_reservations WHERE id=? AND released=0 AND counted=1)`, params: [subject, day, kind, id] },
      { sql: 'UPDATE nalu_usage_reservations SET released=1 WHERE id=?', params: [id] },
    ])
  }
  return { ok, used, limit, release }
}
