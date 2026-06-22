// Nalu web access — Vercel Node serverless function.
// Open-source, no API key: DuckDuckGo (Lite) for search + a readable page fetch,
// so the assistant can look things up and there are no data gaps.
//   POST { action: 'search', query }  -> { text, results:[{title,url,snippet}] }
//   POST { action: 'fetch',  url }    -> { text }   (readable text of the page)

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

// ---- Screen-executor brain (action: 'agent') — merged here to stay under the
// 12-function limit. Decides the next browser action from the page's elements.
const LLM_BASE = (
  env('GLM_BASE_URL') || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
).replace(/\/+$/, '')
const LLM_KEY = env('GLM_API_KEY') || ''
const LLM_MODEL = env('NALU_AGENT_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

const AGENT_SYSTEM = `You control a real web browser to accomplish the user's TASK. You get the current URL, page title, and a numbered list of interactive elements (links, buttons, inputs).
Decide the SINGLE next action. Output ONLY minified JSON: {"action":"click|type|navigate|scroll|wait|done","index":<int>,"text":"<for type>","url":"<for navigate>","reason":"<short>"}
Rules: click→index; type→index+text; navigate→url (e.g. https://www.gmail.com); scroll→when the element isn't listed yet; wait→still loading; done→complete OR a human must finish (password/2FA/payment), put outcome in reason. Never invent indexes. Most direct path. One action per turn.`

async function agentAction(body: Record<string, unknown>): Promise<unknown> {
  if (!LLM_KEY) return { action: 'done', reason: 'engine not configured' }
  const task = typeof body.task === 'string' ? body.task : ''
  const url = typeof body.url === 'string' ? body.url : ''
  const title = typeof body.title === 'string' ? body.title : ''
  const elements = Array.isArray(body.elements)
    ? (body.elements as Array<{ i: number; tag?: string; type?: string; text?: string }>)
    : []
  const history = Array.isArray(body.history) ? (body.history as string[]) : []
  const elList = elements
    .slice(0, 120)
    .map((e) => `[${e.i}] ${e.tag || ''}${e.type ? `(${e.type})` : ''}: ${(e.text || '').slice(0, 80)}`)
    .join('\n')
  const user = `TASK: ${task}\n\nCurrent URL: ${url || '(blank)'}\nPage title: ${title}\n${
    history.length ? `\nActions so far:\n${history.slice(-8).join('\n')}\n` : ''
  }\nInteractive elements:\n${elList || '(none)'}\n\nNext action JSON:`
  try {
    const r = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        max_tokens: 400,
        messages: [
          { role: 'system', content: AGENT_SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    })
    const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
    let txt = (d?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const i = txt.indexOf('{')
    const j = txt.lastIndexOf('}')
    if (i !== -1 && j !== -1) {
      const a = JSON.parse(txt.slice(i, j + 1))
      if (a && typeof a.action === 'string') return a
    }
  } catch {
    /* fall through */
  }
  return { action: 'done', reason: 'Could not decide a next step.' }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function realUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  if (href.startsWith('//')) return 'https:' + href
  return href
}

type Result = { title: string; url: string; snippet: string }

// DuckDuckGo Lite — full web results. Works from residential IPs (e.g. the
// desktop app) but is blocked from datacenter/serverless IPs.
async function ddgLite(query: string): Promise<Result[]> {
  try {
    const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(query)}`,
    })
    const html = await r.text()
    const links = [...html.matchAll(/<a rel="nofollow" href="([^"]*)" class=['"]result-link['"]>([\s\S]*?)<\/a>/g)]
    const snips = [...html.matchAll(/<td class=['"]result-snippet['"]>([\s\S]*?)<\/td>/g)]
    const out: Result[] = []
    for (let i = 0; i < links.length && out.length < 6; i++) {
      const url = realUrl(links[i][1])
      const title = decodeEntities(links[i][2])
      if (title && url) out.push({ title, url, snippet: snips[i] ? decodeEntities(snips[i][1]) : '' })
    }
    return out
  } catch {
    return []
  }
}

// DuckDuckGo Instant Answer — works from anywhere (official API, no key).
async function ddgInstant(query: string): Promise<{ abstract: string; results: Result[] }> {
  try {
    const r = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&t=nalu`,
      { headers: { 'User-Agent': UA } },
    )
    const d = (await r.json()) as {
      AbstractText?: string
      AbstractURL?: string
      Heading?: string
      Results?: Array<{ Text?: string; FirstURL?: string }>
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
    }
    const results: Result[] = []
    const push = (t?: string, u?: string) => {
      if (t && u) results.push({ title: t.split(' - ')[0].slice(0, 100), url: u, snippet: t })
    }
    for (const x of d.Results || []) push(x.Text, x.FirstURL)
    for (const x of d.RelatedTopics || []) {
      if (x.Topics) for (const y of x.Topics) push(y.Text, y.FirstURL)
      else push(x.Text, x.FirstURL)
    }
    const abstract = d.AbstractText ? `${d.Heading || ''}: ${d.AbstractText}${d.AbstractURL ? ` (${d.AbstractURL})` : ''}` : ''
    return { abstract, results: results.slice(0, 5) }
  } catch {
    return { abstract: '', results: [] }
  }
}

// Wikipedia — works from anywhere (no key); strong for facts/entities/topics.
async function wikiSearch(query: string): Promise<Result[]> {
  try {
    const r = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=4`,
      { headers: { 'User-Agent': UA } },
    )
    const d = (await r.json()) as { query?: { search?: Array<{ title?: string; snippet?: string }> } }
    return (d.query?.search || []).map((s) => ({
      title: `${s.title} — Wikipedia`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent((s.title || '').replace(/ /g, '_'))}`,
      snippet: decodeEntities(s.snippet || ''),
    }))
  } catch {
    return []
  }
}

async function search(query: string): Promise<{ text: string; results: Result[] }> {
  // 1) Full web search via DDG Lite (works from residential IPs).
  let results = await ddgLite(query)
  let abstract = ''
  // 2) Fallback that works from the cloud: DDG Instant Answer + Wikipedia.
  if (results.length === 0) {
    const [ia, wiki] = await Promise.all([ddgInstant(query), wikiSearch(query)])
    abstract = ia.abstract
    const seen = new Set<string>()
    results = [...ia.results, ...wiki].filter((x) => {
      if (seen.has(x.url)) return false
      seen.add(x.url)
      return true
    }).slice(0, 8)
  }
  const head = abstract ? `${abstract}\n\n` : ''
  const text =
    results.length || abstract
      ? head + results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n')
      : 'No results found.'
  return { text, results }
}

async function fetchPage(url: string): Promise<{ text: string }> {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' })
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('json')) {
    return { text: `(${ct || 'non-text'} content at ${url})` }
  }
  let html = await r.text()
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const text = decodeEntities(html).slice(0, 6000)
  return { text }
}

// Deep research: search, then READ the top sources in parallel and return a
// consolidated, source-cited brief — far richer than a single search snippet,
// in one tool call (so "look across the web for everything" is one step).
async function research(query: string, depth = 4): Promise<{ text: string; sources: { title: string; url: string }[] }> {
  const { results } = await search(query)
  const top = results.slice(0, Math.max(2, Math.min(6, depth)))
  if (!top.length) return { text: `No web results for "${query}".`, sources: [] }
  const pages = await Promise.all(
    top.map(async (r) => {
      try {
        const { text } = await fetchPage(r.url)
        return { ...r, body: text.replace(/\s+/g, ' ').trim().slice(0, 2200) }
      } catch {
        return { ...r, body: '' }
      }
    }),
  )
  const sections = pages.map(
    (p, i) => `[${i + 1}] ${p.title}\n${p.url}\n${p.body || p.snippet || '(could not read this page)'}`,
  )
  const sources = pages.map((p) => ({ title: p.title, url: p.url }))
  const text = `DEEP RESEARCH on "${query}" — ${pages.length} sources read:\n\n${sections.join('\n\n———\n\n')}\n\nSynthesize the findings above and cite sources by their [n] / URL.`
  return { text, sources }
}

// Google Places Text Search — natural-language "find stuff on the map" (homes,
// land, businesses, schools, parks…). Returns located results for the map view.
const MAPS_KEY = env('GOOGLE_PLACES_KEY') || env('GOOGLE_MAPS_KEY') || env('VITE_GOOGLE_MAPS_KEY') || ''
const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
}
async function placesSearch(query: string, near: string): Promise<unknown> {
  if (!MAPS_KEY) return { error: 'Maps is not configured.', results: [] }
  const q = near ? `${query} in ${near}` : query
  try {
    // Places API (New) — text search. Key in header, fields via field mask.
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': MAPS_KEY,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.types,places.currentOpeningHours.openNow',
      },
      body: JSON.stringify({ textQuery: q, maxResultCount: 20 }),
    })
    const d = (await r.json()) as {
      error?: { status?: string; message?: string }
      places?: Array<Record<string, unknown>>
    }
    if (d.error) return { error: `${d.error.status || ''}${d.error.message ? `: ${d.error.message}` : ''}`.trim(), results: [] }
    const results = (d.places || []).slice(0, 20).map((p) => {
      const loc = p.location as { latitude?: number; longitude?: number } | undefined
      const dn = p.displayName as { text?: string } | undefined
      const pl = p.priceLevel as string | undefined
      return {
        name: dn?.text || '',
        address: (p.formattedAddress as string) || '',
        lat: loc?.latitude ?? null,
        lng: loc?.longitude ?? null,
        rating: (p.rating as number) ?? null,
        userRatings: (p.userRatingCount as number) ?? null,
        priceLevel: pl && pl in PRICE_LEVELS ? PRICE_LEVELS[pl] : null,
        types: (p.types as string[]) || [],
        placeId: (p.id as string) || '',
        openNow: (p.currentOpeningHours as { openNow?: boolean } | undefined)?.openNow ?? null,
        photoUrl: null, // photos would require exposing the server key — omitted
      }
    })
    return { results, status: 'OK' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'places error', results: [] }
  }
}

// Proxy a generated image (Pollinations/FLUX) SERVER-SIDE with retries + backoff,
// returning the bytes as a data URL — so logo images reliably succeed instead of
// the client hammering a rate-limited service. Restricted to the image host.
async function proxyImage(url: string): Promise<{ dataUrl?: string; error?: string }> {
  if (!/^https:\/\/image\.pollinations\.ai\//.test(url)) return { error: 'unsupported image url' }
  for (let attempt = 0; attempt < 8; attempt++) {
    // Later attempts swap FLUX → the faster/more-available "turbo" model as a fallback.
    const u = attempt >= 3 ? url.replace(/model=flux/i, 'model=turbo') : url
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 40000)
      const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
      clearTimeout(t)
      const ct = r.headers.get('content-type') || ''
      if (r.ok && ct.startsWith('image/')) {
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > 1500) return { dataUrl: `data:${ct};base64,${buf.toString('base64')}` }
      }
    } catch {
      /* transient — retry */
    }
    await new Promise((res) => setTimeout(res, 700 * (attempt + 1))) // growing backoff
  }
  return { error: 'image generation failed after retries' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  let body: Record<string, unknown> = {}
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}
  } catch {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }
  const action = typeof body.action === 'string' ? body.action : 'search'
  try {
    if (action === 'agent') {
      res.status(200).json(await agentAction(body))
      return
    }
    if (action === 'fetch') {
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!/^https?:\/\//i.test(url)) {
        res.status(400).json({ error: 'valid url required' })
        return
      }
      res.status(200).json(await fetchPage(url))
      return
    }
    if (action === 'proxyimg') {
      res.status(200).json(await proxyImage(typeof body.url === 'string' ? body.url : ''))
      return
    }
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) {
      res.status(400).json({ error: 'query required' })
      return
    }
    if (action === 'research') {
      const depth = typeof body.depth === 'number' ? body.depth : 4
      res.status(200).json(await research(query, depth))
      return
    }
    if (action === 'places') {
      res.status(200).json(await placesSearch(query, typeof body.near === 'string' ? body.near : ''))
      return
    }
    res.status(200).json(await search(query))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'web error' })
  }
}
