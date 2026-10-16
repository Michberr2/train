import { ProjectDataValidationError } from '../shared/projectMerge'
import { sendIsolatedArtifact } from './_artifactIsolation'
import { storedJson } from './_storedJson'
import { handleNotebook } from './_notebook'
import { reserveDailyQuota } from './_limits'
import { extractNotes } from './_notes'
import { handlePushAction } from './_push'
import { handleCloudflareTasks } from './_cloudflareTasks'
import { runDueCrons, runOneFlow } from './_cron'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareDataStore } from './_cloudflareDataStore'
import { CloudflareTaskLedger } from './_cloudflareTaskLedger'
import { connectionBackend } from './_connectionBackend'
import { readToken, safeJson, newToken } from './_db'
import { syncEntries } from './_syncPayload'
import { ChatDataValidationError } from './_chatMerge'
import { deriveChatActivity, deriveFlowActivity, decorateTaskMedia } from './data'

/** The same account data endpoints use explicit D1 revisions and transactions.
 * No request in this backend falls through to the old PostgreSQL database. */
export async function cloudflareData(req: any, res: any): Promise<void> {
  const store = new CloudflareStore(), documents = new CloudflareDataStore(store), ledger = new CloudflareTaskLedger(store)
  try {
    if (req.method === 'GET') {
      const id = String(req.query?.share || '').replace(/[^a-zA-Z0-9_-]/g, '')
      if (!id) { res.status(400).send('Missing share id'); return }
      const found = (await store.query('SELECT html FROM nalu_shares WHERE id=?', [id])).results[0]
      if (!found) { res.status(404).send('This Nalu site was not found.'); return }
      sendIsolatedArtifact(res, found.html); return
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
    const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}, action = String(body.action || '')
    const isCron = action === 'cron' || req.query?.action === 'cron' || String(req.url || '').includes('action=cron')
    if (isCron) {
      if (!process.env.CRON_SECRET || req.headers?.authorization !== `Bearer ${process.env.CRON_SECRET}`) { res.status(401).json({ error: 'unauthorized' }); return }
      res.status(200).json({ ok: true, ...await runDueCrons(store), at: new Date().toISOString() }); return
    }
    const owner = await connectionBackend().userId(readToken(req))
    if (!owner) { res.status(401).json({ error: 'not authenticated' }); return }
    if(action==='notes-transcribe') {
      const quota=await reserveDailyQuota(req,'notes-audio',{anonPerDay:0,userPerDay:1200})
      if(!quota.ok){res.status(429).json({error:'Daily transcription limit reached. Your audio stays on this phone and will retry tomorrow.'});return}
    }
    if(await handleNotebook(store,owner,body,res))return
    if(action==='notes-analyze') {
      if(typeof body.transcript!=='string'||!body.transcript.trim()||body.transcript.length>8000){res.status(400).json({error:'Transcript must contain 1–8000 characters.'});return}
      const quota=await reserveDailyQuota(req,'notes',{anonPerDay:0,userPerDay:200})
      if(!quota.ok){res.status(429).json({error:'Daily notes limit reached. Your transcript is saved; try again tomorrow.'});return}
      try{res.status(200).json(await extractNotes(body.transcript))}catch{await quota.release();res.status(502).json({error:'Could not extract action items. Your transcript is saved; try again.'})}
      return
    }
    if (await handlePushAction(store,owner,body,res)) return
    if (await handleCloudflareTasks(store,owner,body,res)) return
    if (action === 'flow-run') {
      const flowId = String(body.flowId || ''), mode = (['run','resume','stop'].includes(body.mode) ? body.mode : 'run') as 'run'|'resume'|'stop'
      if (!flowId) { res.status(400).json({ error: 'flowId required' }); return }
      const out = await runOneFlow(store,owner,flowId,mode,!!body.force)
      res.status(out.code || (out.ok ? 200 : 400)).json(out); return
    }
    if (action === 'load') { await storedJson(res.status(200), { data: await documents.load(owner) }); return }
    if (action === 'set') {
      const key = String(body.key || '')
      if (!key) { res.status(400).json({ error: 'key required' }); return }
      const data = await documents.write(owner, key, body.value ?? null)
      res.status(200).json({ ok: true, ...(data ? { data } : {}) }); return
    }
    if (action === 'setMany') {
      let entries: Record<string, unknown>
      try { entries = syncEntries(body) } catch { res.status(400).json({ error: 'Saved data could not be decoded. The local copy has been kept.' }); return }
      const data: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(entries)) Object.assign(data, await documents.write(owner, key, value ?? null))
      res.status(200).json({ ok: true, count: Object.keys(entries).length, ...(Object.keys(data).length ? { data } : {}) }); return
    }
    if (action === 'remove') {
      if (body.key) await documents.remove(owner, String(body.key))
      res.status(200).json({ ok: true }); return
    }
    if (action === 'conversation-turn') {
      const { chatId, turnId, user, assistant, source } = body
      if (!['voice', 'desktop'].includes(source) || typeof chatId !== 'string' || !/^(voice|desktop)-[a-f0-9-]{36}$/i.test(chatId) || typeof turnId !== 'string' || !/^[a-f0-9-]{36}$/i.test(turnId) || typeof user !== 'string' || !user.trim() || user.length > 16000 || typeof assistant !== 'string' || !assistant.trim() || assistant.length > 32000) { res.status(400).json({ error: 'Invalid conversation turn.' }); return }
      res.status(200).json({ ok: true, saved: await documents.appendTurn(owner, { chatId, turnId, user, assistant, source }) }); return
    }
    if (action === 'share') {
      const html = String(body.html || '')
      if (!html) { res.status(400).json({ error: 'html required' }); return }
      if (html.length > 800000) { res.status(413).json({ error: 'This website is too large to publish as a link. Download the complete HTML instead.' }); return }
      const id = newToken().slice(0, 14)
      await store.batch([{ sql: 'INSERT INTO nalu_shares(id,html) VALUES(?,?)', params: [id, html] }])
      res.status(200).json({ ok: true, id, url: `/api/data?share=${id}` }); return
    }
    if (action === 'task-log') {
      const id = String(body.id || '') || `t_${newToken().slice(0, 18)}`
      if (id.startsWith('remote_')) { res.status(409).json({ error: 'remote tasks require a worker lease; use task-update' }); return }
      const task = await ledger.log(owner, id, {
        source: String(body.source || 'cli').slice(0, 24), title: String(body.title || '').slice(0, 300),
        detail: body.detail != null ? String(body.detail).slice(0, 4000) : null, status: body.status != null ? String(body.status).slice(0, 24) : null,
        progress: body.progress != null ? Math.max(0, Math.min(1, Number(body.progress) || 0)) : null, event: body.event != null ? String(body.event).slice(0, 500) : null,
        meta: body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : undefined,
      })
      res.status(task ? 200 : 409).json(task ? { ok: true, task } : { error: 'task id is already in use' }); return
    }
    if (action === 'activity') {
      const tasks = await ledger.list(owner), saved = await documents.read(owner, ['nalu-chats', 'nalu-agent-flows'])
      await storedJson(res.status(200), { tasks: decorateTaskMedia(tasks, owner), chats: deriveChatActivity(saved.values['nalu-chats']), pipelines: deriveFlowActivity(saved.values['nalu-agent-flows']), now: new Date().toISOString() }); return
    }
    if (action === 'task-feed') {
      const since = body.since ? String(body.since) : null, limit = Math.max(1, Math.min(500, Math.floor(Number(body.limit) || 200)))
      if (since && !Number.isFinite(Date.parse(since))) { res.status(400).json({ error: 'Invalid activity timestamp.' }); return }
      await storedJson(res.status(200), { tasks: decorateTaskMedia(await ledger.list(owner, limit, since), owner), now: new Date().toISOString() }); return
    }
    if (action === 'task-clear') {
      const cleared = await ledger.clear(owner, String(body.id || '') || undefined)
      res.status(cleared ? 200 : 409).json(cleared ? { ok: true } : { error: 'cancel the task before clearing it' }); return
    }
    // Additional scheduler, notebook, push and remote-work actions must be
    // explicitly ported before enabling this backend on the public websites.
    res.status(400).json({ error: 'unknown action' })
  } catch (error) {
    const invalid = error instanceof ChatDataValidationError || error instanceof ProjectDataValidationError
    res.status(invalid ? 400 : 503).json({ error: invalid ? error.message : 'Saved data is temporarily unavailable. Your local copy has been kept.' })
  }
}
