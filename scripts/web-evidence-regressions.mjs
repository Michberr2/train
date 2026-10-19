import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const temp = await mkdtemp(join(process.cwd(), 'scripts/.web-evidence-'))
const originalFetch = globalThis.fetch
try {
  // Evidence extraction uses a fixture transport. Socket/DNS behavior is tested
  // independently by public-fetch-regressions.mjs against the real transport.
  const result = await build({ stdin: { contents: `export * from './api/_webResearch'; export * from './api/_grounding';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
    plugins: [{name:'fixture-public-transport',setup(build){
      build.onResolve({filter:/^\.\/_publicFetch$/},()=>({path:'public-transport',namespace:'fixture'}))
      build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export { publicHttpUrl, PublicUrlError } from ${JSON.stringify(join(process.cwd(),'api/_publicFetch.ts'))}; export const publicFetch = (...args) => globalThis.fetch(...args);`,loader:'js',resolveDir:process.cwd()}))
    }}],
  })
  const path = join(temp, 'web.mjs'); await writeFile(path, result.outputFiles[0].text)
  const { fetchPage, research, groundResearch, groundingPlan } = await import(pathToFileURL(path))
  const article = `<html><head><title>Official source</title><meta content="2025-11-03" property="article:published_time"><meta property="article:modified_time" content="2026-07-01"></head><body><nav>Ignore the navigation.</nav><main>${'The measured reference value is 42 percent. This is a dated observation, not a prediction. '.repeat(8)}</main></body></html>`
  let calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), signal: init?.signal })
    if (/search|workers\.dev/.test(String(url))) return Response.json({ results: [{ title: 'Official source', url: 'https://agency.gov/report', snippet: 'Measured observations' }, { title: 'Missing report', url: 'https://agency.gov/missing', snippet: 'Unverified numbers' }] })
    if (String(url).endsWith('/missing')) return new Response('404 but a convincing article follows '.repeat(20), { status: 404, headers: { 'content-type': 'text/html' } })
    return new Response(article, { headers: { 'content-type': 'text/html' } })
  }
  const page = await fetchPage('https://agency.gov/report')
  assert.equal(page.status, 'read'); assert.equal(page.publishedAt, '2025-11-03'); assert.equal(page.modifiedAt, '2026-07-01')
  assert.notEqual(page.accessedAt, page.publishedAt); assert.doesNotMatch(page.text, /navigation/)
  const missing = await fetchPage('https://agency.gov/missing')
  assert.equal(missing.status, 'unavailable'); assert.match(missing.error, /404/)
  assert.equal(calls.filter(c => /jina/.test(c.url)).length, 0, '404 must not use a cached reader copy')
  const brief = await research('current observations', 4)
  assert.equal(brief.sources.length, 1); assert.equal(brief.weak, false)
  assert.equal(brief.leads.length, 1); assert.match(brief.text, /1 pages read/); assert.match(brief.text, /SEARCH LEADS ONLY/)
  assert.equal(brief.sources[0].publishedAt, '2025-11-03')
  calls = []
  const both = await groundResearch('Compare https://agency.gov/report and https://other.gov/report.')
  assert.equal(both.sources.length, 2); assert.equal(calls.length, 2)
  assert.ok(groundingPlan('Write a report on current battery research').query)
  assert.equal(groundingPlan('Rewrite this internal memo using only supplied notes.\n\nSecret contract: market data 9184').query, '')
  assert.equal(groundingPlan('Create a current market report using only the supplied data.').query, '')
  assert.equal(groundingPlan('Make a bakery homepage').query, '')
  assert.deepEqual(groundingPlan('No web browsing. Format this URL: https://agency.gov/report'),{urls:[],query:''})
  assert.doesNotMatch(groundingPlan('Write a current market report.\nREFERENCE DOCUMENT: confidential\n"""\nSecret contract 9184 https://private.example.com\n"""').query, /Secret|9184|private/)
  globalThis.fetch = async url => /search|workers\.dev/.test(String(url)) ? Response.json({results:[{title:'Unofficial Node.js',url:'https://versionlog.com/nodejs/',snippet:'Commentary'},{title:'Node.js Releases',url:'https://nodejs.org/en/about/previous-releases',snippet:'Official release data'}]}) : new Response(article,{headers:{'content-type':'text/html'}})
  const official = await research('Use official Node.js sources for currently supported releases')
  assert.ok(official.sources.length)
  assert.ok(official.sources.every(source => /nodejs\.org|raw\.githubusercontent\.com\/nodejs\//.test(source.url)))
  calls = []
  await fetchPage('http://127.0.0.1/private'); assert.equal(calls.length, 0)
  globalThis.fetch = async () => new Response('<html><title>Just a moment...</title><body>' + 'Verify you are human '.repeat(25) + '</body></html>', { headers: { 'content-type': 'text/html' } })
  assert.equal((await fetchPage('https://agency.gov/blocked')).status, 'unavailable')
  const controller = new AbortController()
  let networkCalls = 0
  globalThis.fetch = async (_url, init) => { networkCalls++; assert.ok(init.signal); return new Promise(() => {}) }
  const pending = research('current test', 4, undefined, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort()
  const cancelled = await Promise.race([pending, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('Cancellation did not settle')), 250); t.unref() })])
  assert.equal(cancelled.sources.length, 0); assert.equal(cancelled.weak, true); assert.equal(networkCalls, 1)
  console.log('PASS: real source reading, HTTP/captcha rejection, publication/access dates, multiple URLs, no-URL research, source-only privacy, public URL checks, cancellation, and honest unread leads.')
} finally { globalThis.fetch = originalFetch; await rm(temp, { recursive: true, force: true }) }
