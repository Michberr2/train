import { fileOperation } from './files'
import { documentOperation } from './documents'

type Statement = { bind(...values: unknown[]): Statement; all(): Promise<{ results: Record<string, unknown>[] }>; first(): Promise<Record<string, unknown> | null> }
type Environment = { DB: { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<{ results: Record<string, unknown>[] }[]> }; NALU_DATA_SECRET?: string; FILES?: Parameters<typeof fileOperation>[1] }
const encoder = new TextEncoder()
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
const bytesToHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
async function readBody(req: Request): Promise<string | null> {
  if (Number(req.headers.get('content-length') || 0) > 1800000) return null
  const reader = req.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > 1800000) { await reader.cancel(); return null }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export async function signRequest(secret: string, method: string, path: string, body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const hash = bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(body)))
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${method}\n${path}\n${hash}`)))
}
async function authorized(req: Request, secret: string | undefined, body: string): Promise<boolean> {
  if (!secret || secret.length < 32) return false
  const timestamp = req.headers.get('x-nalu-time') || '', signature = req.headers.get('x-nalu-signature') || ''
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)) return false
  const expected = await signRequest(secret, req.method, new URL(req.url).pathname, body, timestamp)
  let different = 0
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return different === 0
}
const validParams = (value: unknown): value is unknown[] => Array.isArray(value) && value.length <= 100 && value.every(item => item === null || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))
function prepare(env: Environment, input: { sql?: unknown; params?: unknown }, readOnly = false): Statement {
  if (typeof input.sql !== 'string' || input.sql.length > 100000 || !(readOnly ? /^\s*SELECT\b/i : /^\s*(?:SELECT|INSERT|UPDATE|DELETE)\b/i).test(input.sql) || !validParams(input.params || [])) throw new Error('Invalid query.')
  // D1 prepared statements accept one statement. Schema changes and interactive
  // PostgreSQL transactions are not silently accepted by this service.
  return env.DB.prepare(input.sql).bind(...(input.params || []) as unknown[])
}
export default {
  async fetch(req: Request, env: Environment): Promise<Response> {
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && path === '/health') return json({ ok: true, service: 'nalu-data', provider: 'cloudflare-d1' })
    if (req.method !== 'POST') return json({ error: 'POST required.' }, 405)
    let body: string | null
    try { body = await readBody(req) } catch { return json({ error: 'The request body could not be read.' }, 400) }
    if (body === null) return json({ error: 'Request too large.' }, 413)
    if (!await authorized(req, env.NALU_DATA_SECRET, body)) return json({ error: 'Unauthorized.' }, 401)
    let data: any
    try { data = JSON.parse(body) } catch { return json({ error: 'Invalid JSON.' }, 400) }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Invalid request.' }, 400)
    try {
      if (path === '/v1/files/put' || path === '/v1/files/get') {
        try { return json(await fileOperation(env.DB, env.FILES, path.endsWith('/put') ? 'put' : 'get', data)) }
        catch (error) { return json({ error: error instanceof Error ? error.message : 'File storage failed.' }, 503) }
      }
      if (path === '/v1/query') return json(await prepare(env, data, true).all())
      if (path === '/v1/batch') {
        if (!Array.isArray(data.statements) || !data.statements.length || data.statements.length > 45) return json({ error: 'Supply 1–45 statements.' }, 400)
        return json({ results: await env.DB.batch(data.statements.map((item: any) => prepare(env, item))) })
      }
      if (path.startsWith('/v1/documents/')) {
        const result = await documentOperation(env.DB, path.slice('/v1/documents/'.length), data)
        return json(result.body, result.status)
      }
      return json({ error: 'Unknown operation.' }, 404)
    } catch {
      // SQL text/parameters can contain personal data. Keep them out of logs and
      // transport errors, and never acknowledge a failed batch as saved.
      return json({ error: 'The database operation failed.' }, 503)
    }
  },
}
