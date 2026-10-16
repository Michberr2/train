import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** Read-only checks: no real login, generation, account changes, email or calls.
 * Exact response contracts reject missing functions and the SPA's HTML fallback. */
export async function checkPreview(base, { fetchImpl = globalThis.fetch, expectedEntrySha256 } = {}) {
  const origin = new URL(base)
  assert.ok(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use HTTPS or a local fixture')
  assert.equal(origin.username + origin.password, '', 'Do not put credentials in the URL')
  const get = async path => {
    const url = new URL(path, origin)
    url.searchParams.set('_nalu_release_check', String(Date.now()))
    const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25000), headers: { 'cache-control': 'no-cache' } })
    return response
  }
  const healthResponse = await get('/api/health')
  assert.equal(healthResponse.status, 200, `${origin.host}: health HTTP ${healthResponse.status}`)
  assert.match(healthResponse.headers.get('content-type') || '', /application\/json/i, `${origin.host}: health is not JSON`)
  const health = await healthResponse.json()
  assert.equal(health.ok, true, `${origin.host}: health is degraded`)
  assert.equal(health.checks?.db?.ok, true, `${origin.host}: database health failed`)
  assert.equal(health.config?.llmPrimary, true, `${origin.host}: primary model is not configured`)
  const page = await get('/')
  assert.equal(page.status, 200, `${origin.host}: landing HTTP ${page.status}`)
  assert.match(page.headers.get('content-type') || '', /text\/html/i, `${origin.host}: landing is not HTML`)
  const html = await page.text()
  const entry = html.match(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/i)?.[1]
  assert.ok(entry, `${origin.host}: built JavaScript entry is missing`)
  const entryUrl = new URL(entry, origin)
  assert.equal(entryUrl.origin, origin.origin, `${origin.host}: unexpected external app entry`)
  const script = await get(entryUrl.pathname + entryUrl.search)
  assert.equal(script.status, 200, `${origin.host}: JavaScript entry HTTP ${script.status}`)
  assert.match(script.headers.get('content-type') || '', /(?:javascript|ecmascript)/i, `${origin.host}: JavaScript entry is an HTML fallback`)
  const entrySha256 = createHash('sha256').update(Buffer.from(await script.arrayBuffer())).digest('hex')
  if (expectedEntrySha256) assert.equal(entrySha256, expectedEntrySha256, `${origin.host}: served JavaScript differs from the verified deployment`)
  const routes = [
    ...['auth', 'doc', 'sheet', 'slides', 'design', 'image', 'video', 'chat', 'team'].map(name => ({ path: `/api/${name}`, status: 405 })),
    ...['artifacts', 'task-attachments', 'studio-image'].map(name => ({ path: `/api/${name}`, status: 401 })),
  ]
  for (const route of routes) {
    const response = await get(route.path)
    assert.equal(response.status, route.status, `${origin.host}${route.path}: expected ${route.status}, got ${response.status}`)
    assert.match(response.headers.get('content-type') || '', /application\/json/i, `${origin.host}${route.path}: missing JSON handler`)
    const body = await response.json()
    assert.equal(typeof body.error, 'string', `${origin.host}${route.path}: missing error contract`)
    assert.ok(body.error.length > 0)
  }
  // The public share handler intentionally uses a plain-text error contract.
  // Omitting the ID proves the route exists without touching saved shares.
  const data = await get('/api/data')
  assert.equal(data.status, 400, `${origin.host}/api/data: expected missing-share validation, got ${data.status}`)
  assert.equal(await data.text(), 'Missing share id', `${origin.host}/api/data: missing share-handler contract`)
  return { origin: origin.origin, health: { ok: health.ok, database: health.checks.db.ok, model: health.config.llmModel }, entry, entrySha256, checkedRoutes: routes.length + 1 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2]
  if (!base) throw new Error('Usage: node scripts/preview-release-checks.mjs https://verified-deployment.vercel.app')
  const result = await checkPreview(base)
  console.log(JSON.stringify(result, null, 2))
}
