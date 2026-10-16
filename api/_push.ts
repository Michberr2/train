import { CloudflareStore } from './_cloudflareStore'
import { CloudflarePush } from './_cloudflarePush'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { connect } from 'node:http2'
import { getClient, ensureSchema } from './_db'

type Client = { query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }
const topic = 'ai.n4lu.mobile'
export const pushConfigured = () => !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_PRIVATE_KEY)
export const validDevice = (b: any) => typeof b.deviceToken === 'string' && /^[a-f0-9]{32,512}$/i.test(b.deviceToken) && ['development','production'].includes(b.environment)
export async function ensurePushSchema(c: Client) {
  await c.query(`CREATE TABLE IF NOT EXISTS nalu_push_devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    token TEXT NOT NULL, environment TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    enabled_since TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS nalu_push_devices_owner ON nalu_push_devices(user_id);
  CREATE TABLE IF NOT EXISTS nalu_push_deliveries (
    device_id TEXT NOT NULL REFERENCES nalu_push_devices(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
    reason TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(device_id,event_id)
  );`)
}
export function notificationPayload(uid: string, taskId: string, kind: string) {
  const body = kind === 'question' ? 'Nalu needs your answer. Tap to continue.' : kind === 'failed' ? 'A task needs attention. Tap to review.' : 'Your result is ready. Tap to open Nalu.'
  return { aps: { alert: { title: 'Nalu', body }, sound: 'default', 'thread-id': 'nalu-tasks' }, userId: uid, taskId, kind }
}
export async function sendApplePush(device: { token: string; environment: string }, eventId: string, payload: object): Promise<{ status: number; reason: string }> {
  if (!pushConfigured()) return { status: 503, reason: 'Push credentials are not configured.' }
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now()/1000) })).toString('base64url')
  const data = `${header}.${claims}`
  const key = createPrivateKey(process.env.APNS_PRIVATE_KEY!.replace(/\\n/g,'\n'))
  const jwt = `${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
  return new Promise(resolve => {
    const session = connect(device.environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com')
    let done = false, code = 0, response = ''
    const finish = (status: number, reason: string) => { if (done) return; done = true; clearTimeout(timer); session.destroy(); resolve({ status, reason }) }
    const timer = setTimeout(() => finish(0, 'Delivery acknowledgement timed out.'), 10000)
    session.on('error', () => finish(0, 'Apple connection failed.'))
    const req = session.request({ ':method':'POST', ':path':`/3/device/${device.token}`, authorization:`bearer ${jwt}`, 'apns-topic':topic, 'apns-push-type':'alert', 'apns-priority':'10', 'apns-expiration':String(Math.floor(Date.now()/1000)+3600), 'apns-collapse-id':createHash('sha256').update(eventId).digest('hex') })
    req.on('response', headers => { code = Number(headers[':status']) })
    req.on('data', chunk => { if (response.length < 4096) response += chunk.toString() })
    req.on('error', () => finish(0, 'Apple request failed.'))
    req.on('end', () => { let reason = ''; try { reason = JSON.parse(response).reason || '' } catch {} finish(code, reason) })
    req.end(JSON.stringify(payload))
  })
}
export async function handlePushAction(c: Client | CloudflareStore, uid: string, b: any, res: any): Promise<boolean> {
  if (c instanceof CloudflareStore) return new CloudflarePush(c).handle(uid,b,res)
  if (!['push-register','push-unregister','push-status','push-test'].includes(b.action)) return false
  await ensurePushSchema(c)
  if (b.action === 'push-status') {
    const devices = (await c.query('SELECT environment,enabled,updated_at FROM nalu_push_devices WHERE user_id=$1',[uid])).rows
    res.status(200).json({ ok:true, configured:pushConfigured(), devices }); return true
  }
  if (!validDevice(b)) { res.status(400).json({ error:'Valid iPhone device token and push environment required.' }); return true }
  const token = b.deviceToken.toLowerCase(), id = createHash('sha256').update(`${b.environment}:${token}`).digest('hex')
  if (b.action === 'push-unregister') {
    await c.query('DELETE FROM nalu_push_devices WHERE id=$1 AND user_id=$2',[id,uid])
  } else if (b.action === 'push-register') {
    await c.query(`INSERT INTO nalu_push_devices(id,user_id,token,environment) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,enabled=TRUE,
      enabled_since=CASE WHEN nalu_push_devices.user_id=EXCLUDED.user_id AND nalu_push_devices.enabled THEN nalu_push_devices.enabled_since ELSE NOW() END,
      updated_at=NOW()`,[id,uid,token,b.environment])
  } else {
    const d=(await c.query('SELECT * FROM nalu_push_devices WHERE id=$1 AND user_id=$2 AND enabled=TRUE',[id,uid])).rows[0]
    if (!d) { res.status(404).json({ error:'Enable notifications on this device first.' }); return true }
    if (!pushConfigured()) { res.status(503).json({ error:'Apple push credentials still need configuration.' }); return true }
    const eventId=`test:${Math.floor(Date.now()/60000)}`
    const claim=(await c.query("INSERT INTO nalu_push_deliveries(device_id,event_id,status) VALUES($1,$2,'sending') ON CONFLICT DO NOTHING RETURNING device_id",[id,eventId])).rows
    if (!claim.length) { res.status(429).json({ error:'Wait a minute before sending another test.' }); return true }
    const sent=await sendApplePush(d,eventId,{aps:{alert:{title:'Nalu',body:'Notifications are connected.'},sound:'default'},userId:uid,kind:'test'})
    await c.query('UPDATE nalu_push_deliveries SET status=$3,reason=$4,updated_at=NOW() WHERE device_id=$1 AND event_id=$2',[id,eventId,sent.status===200?'accepted':'rejected',sent.reason])
    res.status(sent.status===200?200:502).json({ ok:sent.status===200, accepted:sent.status===200, error:sent.status===200?undefined:sent.reason||'Apple rejected the notification.' }); return true
  }
  res.status(200).json({ ok:true, configured:pushConfigured() }); return true
}
// Runs on the server when a job changes, plus cron recovery: the app need not be open.
export async function deliverPushUpdates(uid?: string) {
  if (!pushConfigured()) return
  if (process.env.NALU_STORAGE_BACKEND === 'cloudflare') { await new CloudflarePush(new CloudflareStore()).deliver(uid).catch(error=>console.error('[push] delivery failed:',error instanceof Error?error.name:'error')); return }
  const c=getClient(); let locked=false
  try {
    await c.connect(); await ensureSchema(c); await ensurePushSchema(c)
    locked=(await c.query("SELECT pg_try_advisory_lock(hashtext('nalu-push-delivery')) AS locked")).rows[0]?.locked===true
    if (!locked) return
    const deadline=Date.now()+40000
    const rows=(await c.query(`SELECT d.id AS device_id,d.token,d.environment,d.user_id,t.id AS task_id,t.status,
      CASE WHEN t.status='waiting' THEN 'question:' || (t.meta->'pendingQuestion'->>'id') ELSE t.status END AS kind
      FROM nalu_push_devices d JOIN nalu_tasks t ON t.user_id=d.user_id
      WHERE d.enabled=TRUE AND d.updated_at>NOW()-INTERVAL '90 days' AND ($1::text IS NULL OR d.user_id=$1)
      AND t.updated_at>=d.enabled_since AND t.updated_at>NOW()-INTERVAL '1 day'
      AND (t.status IN ('done','failed') OR (t.status='waiting' AND t.meta->'pendingQuestion'->>'id' IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM nalu_push_deliveries p WHERE p.device_id=d.id
        AND p.event_id=t.id || ':' || CASE WHEN t.status='waiting' THEN 'question:' || (t.meta->'pendingQuestion'->>'id') ELSE t.status END
        AND (p.status IN ('accepted','rejected') OR p.attempts>=5 OR p.updated_at>NOW()-INTERVAL '2 minutes'))
      ORDER BY t.updated_at LIMIT 50`,[uid||null])).rows
    for (const row of rows) {
      if (Date.now()>deadline) break
      if (row.kind.startsWith('question:')) {
        const current=(await c.query("SELECT id FROM nalu_tasks WHERE id=$1 AND user_id=$2 AND status='waiting' AND meta->'pendingQuestion'->>'id'=$3",[row.task_id,row.user_id,row.kind.slice(9)])).rows
        if (!current.length) continue
      }
      const eventId=`${row.task_id}:${row.kind}`
      await c.query(`INSERT INTO nalu_push_deliveries(device_id,event_id,status) VALUES($1,$2,'sending')
        ON CONFLICT(device_id,event_id) DO UPDATE SET status='sending',attempts=nalu_push_deliveries.attempts+1,updated_at=NOW()`,[row.device_id,eventId])
      let sent: {status:number;reason:string}
      try { sent=await sendApplePush(row,eventId,notificationPayload(row.user_id,row.task_id,row.kind.startsWith('question:')?'question':row.status)) }
      catch { sent={status:0,reason:'Push provider configuration or connection failed.'} }
      const retry=sent.status===0 || sent.status===429 || sent.status>=500 || sent.status===403
      await c.query('UPDATE nalu_push_deliveries SET status=$3,reason=$4,updated_at=NOW() WHERE device_id=$1 AND event_id=$2',[row.device_id,eventId,sent.status===200?'accepted':retry?'retry':'rejected',sent.reason])
      if (sent.status===410 || sent.reason==='BadDeviceToken' || sent.reason==='DeviceTokenNotForTopic') await c.query('UPDATE nalu_push_devices SET enabled=FALSE WHERE id=$1',[row.device_id])
    }
  } catch (error) { console.error('[push] delivery failed:',error instanceof Error?error.name:'error') }
  finally { if(locked)await c.query("SELECT pg_advisory_unlock(hashtext('nalu-push-delivery'))").catch(()=>{});await c.end().catch(()=>{}) }
}
