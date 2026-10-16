// Shared offline fixtures: real server runner/artifact SQL and real HTTP handler,
// with only PostgreSQL sessions/storage and the model replaced. Never connects.
import { build } from 'esbuild'

export async function loadArtifactServer() {
  const result = await build({
    stdin: { contents: "export * from './api/_cron.ts'; export * from './api/_autopilotArtifacts.ts'; export { default as artifactHandler } from './api/artifacts.ts'", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'offline-services', setup(build) {
      build.onResolve({filter:/^\.\/connect$/},()=>({path:'connect',namespace:'delivery-fixture'}))
      build.onLoad({filter:/.*/,namespace:'delivery-fixture'},()=>({contents:'export async function sendPipelineOutput(...args){if(!globalThis.__artifactDelivery)throw new Error("Unexpected delivery");return globalThis.__artifactDelivery(...args)}',loader:'js'}))
      build.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'model', namespace: 'offline' }))
      build.onResolve({ filter: /^\.\/_db$/ }, () => ({ path: 'db', namespace: 'offline' }))
      build.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ loader: 'js', contents: path === 'model'
        ? 'export async function chatComplete(...args) { if (!globalThis.__artifactModel) throw new Error("Unexpected model call"); return globalThis.__artifactModel(...args) }'
        : `export const getClient=()=>globalThis.__artifactDatabase;
           export const safeJson=s=>{try{return JSON.parse(s)}catch{return {}}};
           export const readToken=req=>(req.headers.authorization||'').replace(/^Bearer /,'')||null;
           export const userIdForToken=async(c,t)=>(await c.query('SELECT user_id FROM nalu_sessions WHERE token=$1',[t])).rows[0]?.user_id||null;`,
      }))
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

export function artifactDatabase(flow, userId = 'artifact-user') {
  const flows = new Map([[userId, [structuredClone(flow)]]])
  const artifacts = new Map(), tasks = new Map(), events = [], locks = new Set()
  return {
    flows, artifacts, tasks, events, locks, userId,
    get flow() { return structuredClone(flows.get(userId)[0]) },
    set flow(value) { flows.set(userId, [structuredClone(value)]) },
    beforeQuery: null,
    async connect() {}, async end() {},
    async query(sql, params = []) {
      await this.beforeQuery?.(sql, params)
      const q = sql.trim()
      if (q.includes('pg_try_advisory_lock')) { const locked = !locks.has(params[0]); if (locked) locks.add(params[0]); return { rows: [{ locked }] } }
      if (q.includes('pg_advisory_unlock')) { locks.delete(params[0]); return { rows: [] } }
      if (q.startsWith('CREATE TABLE') || /^(BEGIN|COMMIT|ROLLBACK)$/.test(q)) return { rows: [] }
      if (q.includes('FROM nalu_sessions')) return { rows: params[0] === 'fixture-owner' ? [{ user_id: userId }] : params[0] === 'fixture-other' ? [{ user_id: 'other-user' }] : [] }
      if (q.startsWith('SELECT key,value FROM nalu_user_data')) return { rows: flows.has(params[0]) ? [{ key: 'nalu-agent-flows', value: JSON.stringify(flows.get(params[0])) }] : [] }
      if (/^SELECT .*value FROM nalu_user_data/.test(q)) return { rows: [...flows.entries()].filter(([id]) => !params.length || id === params[0]).map(([user_id, value]) => ({ user_id, value: JSON.stringify(value) })) }
      if (/^(INSERT INTO|UPDATE) nalu_user_data/.test(q)) { flows.set(params[0], JSON.parse(params[1])); return { rows: [] } }
      if (q.startsWith('UPDATE nalu_tasks')) {
        if (params[1] === userId && ['queued', 'running', 'waiting'].includes(tasks.get(params[0]))) tasks.set(params[0], 'cancelled')
        return { rows: [] }
      }
      if (q.startsWith('SELECT * FROM nalu_tasks')) return { rows: [] }
      if (q.includes('nalu_tasks')) { tasks.set(params[0], params[5]); events.push(params); return { rows: [] } }
      if (q.startsWith('INSERT INTO nalu_autopilot_artifacts')) {
        if (!artifacts.has(params[0])) artifacts.set(params[0], { userId: params[1], meta: JSON.parse(params[2]), bytes: Buffer.from(params[3]), result: params[4] })
        return { rows: [] }
      }
      if (/^SELECT meta, bytes(?:, result)? FROM nalu_autopilot_artifacts/.test(q)) {
        const item = artifacts.get(params[1]); return { rows: item?.userId === params[0] ? [{ meta: item.meta, bytes: item.bytes, result: item.result }] : [] }
      }
      if (q.startsWith('SELECT meta,bytes FROM nalu_autopilot_artifacts')) return { rows: [...artifacts.values()].filter(item => item.userId === params[0] && (item.meta.runId === params[1] || `flow_def_${item.meta.flowId}` === params[1])).map(item => ({ meta: item.meta, bytes: item.bytes })) }
      if (q.startsWith('SELECT meta FROM nalu_autopilot_artifacts')) return { rows: [...artifacts.values()].filter((item) => item.userId === params[0]).sort((a, b) => b.meta.ts - a.meta.ts || b.meta.id.localeCompare(a.meta.id)).slice(0, 60).map(({ meta }) => ({ meta })) }
      if (q.startsWith('DELETE FROM nalu_autopilot_artifacts')) { if (artifacts.get(params[1])?.userId === params[0]) artifacts.delete(params[1]); return { rows: [] } }
      throw new Error(`Unexpected fixture query: ${q}`)
    },
  }
}

export async function artifactRequest(handler, database, { token = 'fixture-owner', id, method = 'GET', body } = {}) {
  globalThis.__artifactDatabase = database
  const response = {
    code: 200, headers: {}, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = String(value) },
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
    send(body) { this.body = body; return this },
    end() { return this },
  }
  await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: id == null ? {} : { id }, body }, response)
  return response
}
