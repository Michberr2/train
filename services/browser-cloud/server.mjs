import http from 'node:http'
import { DeviceRuntime } from '../browser-device/runtime.mjs'
import { equal } from '../browser-device/policy.mjs'
import { startProxy } from '../browser-host/proxy.mjs'
const owner = process.env.NALU_BROWSER_OWNER, key = process.env.NALU_BROWSER_KEY
if (!owner || !key || key.length < 32) throw Error('Private browser identity is required.')
let token = '', closing = false
const runtime = new DeviceRuntime({ decide: async (_owner, input, signal) => {
  if (!token || closing) throw Error('Browser session ended. Open Browser to continue.')
  const response = await fetch('https://n4lu.com/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...input, action: 'agentstep' }), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) })
  if (!response.ok) throw Error('Browser AI is temporarily unavailable.')
  const result = await response.json()
  if (result.error) throw Error('Browser AI could not decide the next step.')
  return result
} })
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)) }
const allowed = new Set(['workspace_status','workspace_screen','workspace_open','workspace_run','workspace_resume','workspace_takeover','workspace_close','workspace_input','workspace_tab','shutdown'])
const server = http.createServer(async (req,res) => {
  if (req.method !== 'POST' || req.url !== '/browser' || !equal(req.headers.authorization, `Bearer ${key}`)) return send(res,403,{error:'Private browser access required.'})
  try {
    let text = ''
    for await (const chunk of req) { text += chunk; if(text.length > 60000) throw Error('Request too large.') }
    const body = JSON.parse(text)
    if (!allowed.has(body.action) || body.owner !== owner) return send(res,403,{error:'Browser ownership mismatch.'})
    if (body.action === 'shutdown') { closing = true; token = ''; await runtime.disconnect(); return send(res,200,{ok:true,status:'paused',active:false}) }
    if (closing) return send(res,409,{error:'This browser session has paused. Open Browser to continue.'})
    if (typeof body.token !== 'string' || body.token.length < 10 || body.token.length > 16384) return send(res,401,{error:'Sign in again.'})
    token = body.token
    const result = await runtime.request(owner,body.action,body.data || {})
    send(res,200,{...result,runtime:'hosted'})
  } catch(error) { send(res,400,{error:error instanceof Error ? error.message.slice(0,300) : 'Browser operation failed.'}) }
})
async function main() { await startProxy(); server.listen(8877,'0.0.0.0') }
async function close() { closing=true;token='';await runtime.disconnect();server.close();process.exit(0) }
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close())
// Flush profiles before the infrastructure's hard deadline. Never silently
// continue an interrupted task after the process restarts.
const end = Number(process.env.NALU_BROWSER_EXPIRES)
if (Number.isFinite(end)) setTimeout(()=>void close(),Math.max(1000,end-Date.now()-20000)).unref()
void main().catch(()=>process.exit(1))
