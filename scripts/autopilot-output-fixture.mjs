// Real attachment handler, only SQL/session storage replaced; no accounts/network.
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { artifactDatabase } from './autopilot-artifact-fixture.mjs'

export async function attachmentFixture(flow) {
  const db = artifactDatabase(flow)
  const storedQuery = db.query.bind(db)
  db.attachments = new Map()
  db.query = async (sql, params = []) => {
    const q = sql.trim()
    if (q.startsWith('CREATE TABLE')) return { rows: [] }
    if (q.startsWith('INSERT INTO nalu_task_attachments(')) {
      if (!db.attachments.has(params[0])) db.attachments.set(params[0], { userId: params[1], meta: JSON.parse(params[2]), ready: false, parts: new Map() })
      return { rows: [] }
    }
    if (q.startsWith('SELECT a.meta,p.bytes')) {
      const file = db.attachments.get(params[1]), bytes = file?.parts.get(params[2])
      return { rows: file?.userId === params[0] && file.ready && bytes ? [{ meta: file.meta, bytes }] : [] }
    }
    if (q.startsWith('SELECT meta FROM nalu_task_attachments WHERE user_id=$1 AND ready=TRUE')) {
      const rows = [...db.attachments.values()].filter(file => file.userId === params[0] && file.ready && (!params[1] || file.meta.taskId === params[1] || `flow_def_${file.meta.flowId}` === params[1]) && (!params[2] || file.meta.id > params[2])).sort((a, b) => a.meta.id.localeCompare(b.meta.id)).slice(0, 101)
      return { rows: rows.map(file => ({ meta: file.meta })) }
    }
    if (/^SELECT (meta|meta,ready|ready) FROM nalu_task_attachments/.test(q)) {
      const file = db.attachments.get(params[1])
      return { rows: file?.userId === params[0] ? [{ meta: file.meta, ready: file.ready }] : [] }
    }
    if (q.startsWith('SELECT bytes FROM nalu_task_attachment_parts WHERE attachment_id=$1 AND part=')) {
      const bytes = db.attachments.get(params[0])?.parts.get(params[1])
      return { rows: bytes ? [{ bytes }] : [] }
    }
    if (q.startsWith('SELECT bytes FROM nalu_task_attachment_parts WHERE attachment_id=$1 ORDER BY part')) {
      return { rows: [...(db.attachments.get(params[0])?.parts.entries() || [])].sort((a, b) => a[0] - b[0]).map(([, bytes]) => ({ bytes })) }
    }
    if (q.startsWith('INSERT INTO nalu_task_attachment_parts(')) {
      const file = db.attachments.get(params[0]); if (!file.parts.has(params[1])) file.parts.set(params[1], Buffer.from(params[2]))
      return { rows: [] }
    }
    if (q.startsWith('UPDATE nalu_task_attachments SET ready=TRUE')) {
      const file = db.attachments.get(params[1]); if (file?.userId === params[0]) file.ready = true
      return { rows: [] }
    }
    return storedQuery(sql, params)
  }
  const bundle = await build({ entryPoints: ['api/task-attachments.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', plugins: [{ name: 'isolated-attachment-db', setup(build) {
    // Never choose a real Cloudflare/Postgres backend based on the shell's env.
    // Session resolution and every attachment SQL operation still use the
    // owner-aware fixture database; the real HTTP handler remains unchanged.
    build.onResolve({ filter: /^\.\/_connectionBackend$/ }, () => ({ path: 'fixture-backend', namespace: 'fixture-backend' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture-backend' }, () => ({ contents: `export function connectionBackend(){const client=globalThis.__outputFixtureDb;return{client,connect:()=>client.connect(),close:()=>client.end(),userId:async token=>token?(await client.query('SELECT user_id FROM nalu_sessions WHERE token=$1',[token])).rows[0]?.user_id||null:null}}` }))
    build.onResolve({ filter: /^\.\/_db$/ }, () => ({ path: 'fixture-db', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const getClient=()=>globalThis.__outputFixtureDb;export const normalizePhone=()=>{throw new Error("Unexpected phone action in attachment fixture")};export const readToken=req=>(req.headers.authorization||'').replace(/^Bearer /,'')||null;export const userIdForToken=async(c,t)=>(await c.query('SELECT user_id FROM nalu_sessions WHERE token=$1',[t])).rows[0]?.user_id||null;export const safeJson=s=>{try{return JSON.parse(s)}catch{return {}}}` }))
  } }] })
  // Resolve external packages from this repository, not a data: URL (which
  // cannot resolve the cancellation helper's @vercel/functions dependency).
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  const handler = module.exports.default
  return { db, async request({ token = 'fixture-owner', method = 'POST', body = {}, query = {} } = {}) {
    globalThis.__outputFixtureDb = db
    const response = { code: 200, headers: {}, body: undefined, setHeader(name, value) { this.headers[name.toLowerCase()] = value }, status(code) { this.code = code; return this }, json(body) { this.body = body; return this }, end() {} }
    await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body, query }, response)
    return response
  } }
}
