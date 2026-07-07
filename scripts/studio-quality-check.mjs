// Nalu Studio — best-in-class quality gate. Exercises EVERY studio generator
// against the REAL model backends and asserts each result meets the quality
// bar (structure, completeness, correctness). Run:
//   node --experimental-strip-types scripts/studio-quality-check.mjs [filter]
// Env comes from .env.local. Exits non-zero if any hard check fails.
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/)
  if (m && m[2]) process.env[m[1]] = m[2]
}
process.env.NALU_FREE_STUDIO_PER_DAY = '0' // unlimited while testing
process.env.NALU_FREE_VIDEO_PER_DAY = '0'

// ---------- tiny harness ----------
const results = []
function check(name, fn, { hard = true } = {}) {
  return { name, fn, hard }
}
async function invoke(modPath, body, { timeoutMs = 240000 } = {}) {
  const { default: handler } = await import(join(ROOT, modPath))
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`handler timeout ${timeoutMs}ms`)), timeoutMs)
    const req = { method: 'POST', body, headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    const chunks = []
    const res = {
      _status: 200,
      setHeader() {}, flushHeaders() {},
      status(c) { this._status = c; return this },
      json(d) { clearTimeout(t); resolve({ status: this._status, json: d, sse: '' }) },
      write(s) { chunks.push(String(s)) },
      end() { clearTimeout(t); resolve({ status: this._status, json: null, sse: chunks.join('') }) },
    }
    handler(req, res).catch((e) => { clearTimeout(t); reject(e) })
  })
}
class Asserts {
  constructor() { this.fails = []; this.notes = [] }
  ok(cond, msg) { if (!cond) this.fails.push(msg); return !!cond }
  note(msg) { this.notes.push(msg) }
}

const PHOTO = '/Users/michaelberryii/Pictures/Photos Library.photoslibrary/resources/derivatives/masters/8/80891D6B-D57F-4D60-997B-013819683A26_4_5005_c.jpeg'

// blueprint geometry re-check (mirror of the server validator)
function bpOverlaps(payload) {
  const FIX = /\b(island|fridge|refrigerator|range|stove|oven|dish|sink|toilet|wc|tub|bath(?!room)|shower|vanity|bed(?!room)|sofa|couch|table|desk|closet|wardrobe|washer|dryer|counter|cabinet|fireplace|stair|car|parking|lawn|landscap|deck|patio|pool|drive)/i
  const floors = Array.isArray(payload.floors) ? payload.floors : [{ viewBox: payload.viewBox, shapes: payload.shapes }]
  const bad = []
  for (const f of floors) {
    const rooms = (f.shapes || []).filter((s) => s?.type === 'rect' && s.label && !FIX.test(s.label) && !/exterior|property|residence/i.test(s.label) && s.w * s.h >= 15)
    for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i], b = rooms[j]
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (ox > 1 && oy > 1) bad.push(`${f.name || 'floor'}: ${a.label} x ${b.label}`)
    }
  }
  return bad
}

// ---------- the checks ----------
const CHECKS = [
  check('website-generic', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'a website for my neighborhood bakery in Austin', kind: 'webpage' }, { timeoutMs: 340000 })
    a.ok(r.status === 200, `status ${r.status}: ${JSON.stringify(r.json).slice(0, 120)}`)
    const html = r.json?.html || ''
    a.ok(html.length > 22000, `too small for a full site: ${html.length}B`)
    a.ok(/^<!doctype/i.test(html.trim()) && /<\/html>\s*$/i.test(html.trim()), 'not a complete document')
    a.ok(/<meta[^>]+viewport/i.test(html), 'missing viewport meta (responsive)')
    a.ok((html.match(/@media|md:|lg:/g) || []).length >= 2, 'no responsive breakpoints')
    a.ok(/pollinations|picsum/i.test(html), 'no themed images')
    a.ok(/importmap/i.test(html) && /<canvas/i.test(html), 'no WebGL scene (importmap + canvas)')
    a.ok((html.match(/<section|data-page|id="page/gi) || []).length >= 4, 'fewer than 4 sections/pages')
    // fully baked, never a skeleton: real written copy on the page
    const words = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length
    a.ok(words >= 450, `skeleton: only ${words} words of real copy`)
    const badLS = /localStorage/.test(html) && !/try\s*\{[\s\S]{0,200}?(localStorage|sessionStorage)/.test(html)
    a.ok(!badLS, 'unguarded localStorage (would crash the sandboxed preview)')
    a.note(`${(html.length / 1024).toFixed(0)}KB html, ${words} words`)
  }),
  check('website-detailed', async (a) => {
    const r = await invoke('api/design.ts', {
      prompt: 'Build a website for "Copper Kettle", a bakery at 412 Alder Lane. Tagline exactly: "Slow mornings, honest bread". Pages: Home, Menu (sourdough loaf $6, cardamom bun $4.50), About (founded 2019 by two sisters), Visit (address, hours 7am-2pm). Warm terracotta and cream palette.',
      kind: 'webpage',
    }, { timeoutMs: 340000 })
    a.ok(r.status === 200, `status ${r.status}`)
    const html = r.json?.html || ''
    a.ok(html.includes('Copper Kettle'), 'brand name missing')
    a.ok(/Slow mornings, honest bread/i.test(html), 'exact tagline missing')
    a.ok(/412 Alder Lane/i.test(html), 'address missing')
    a.ok(/sourdough/i.test(html) && /\$6/.test(html), 'menu items/prices missing')
    a.ok(/<\/html>\s*$/i.test(html.trim()), 'truncated document')
    a.note(`${(html.length / 1024).toFixed(0)}KB html`)
  }),
  check('board-photo-breakdown', async (a) => {
    a.ok(existsSync(PHOTO), 'reference photo missing')
    const dataUrl = 'data:image/jpeg;base64,' + readFileSync(PHOTO).toString('base64')
    // 1) vision analysis (same model/route chat uses)
    const vr = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'Qwen/Qwen3-VL-30B-A3B-Instruct', max_tokens: 1600, messages: [{ role: 'user', content: [
        { type: 'text', text: 'Analyze this photo exhaustively for a design team: subject, style, every visible element with materials and estimated dimensions, colors with hex estimates, visible text verbatim, spatial layout.' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] }] }),
    }).then((x) => x.json())
    const analysis = vr.choices?.[0]?.message?.content || ''
    a.ok(analysis.length > 400, `vision analysis too thin (${analysis.length} chars)`)
    a.ok(/hous|architect|casa|facade|board|minimal/i.test(analysis), 'vision analysis missed the subject')
    // 2) the board build
    const r = await invoke('api/design.ts', { prompt: 'build the end to end breakdown of everything in this photo', kind: 'board', analysis })
    a.ok(r.status === 200, `status ${r.status}: ${JSON.stringify(r.json).slice(0, 120)}`)
    const html = r.json?.html || ''
    a.ok(html.includes('{{PHOTO_0}}'), 'photo placeholder missing (hero photo would not embed)')
    a.ok(/<svg/i.test(html), 'no SVG technical diagram')
    a.ok(/material/i.test(html), 'no materials section')
    a.ok(html.length > 12000, `board too thin: ${html.length}B`)
    a.ok(/<\/html>\s*$/i.test(html.trim()), 'truncated board')
    a.note(`${(html.length / 1024).toFixed(0)}KB board, analysis ${analysis.length} chars`)
  }),
  check('blueprint', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'Design a detailed floor plan for a 3-bedroom house with an open kitchen, 2.5 baths, laundry, and a 2-car garage', kind: 'blueprint' })
    a.ok(r.status === 200, `status ${r.status}`)
    const p = r.json || {}
    const floors = Array.isArray(p.floors) ? p.floors : []
    a.ok(floors.length >= 1, 'no floors')
    const building = floors.filter((f) => !/site/i.test(f.name || ''))
    a.ok(building.length >= 1, 'no building floor')
    const shapes = building[0]?.shapes || []
    a.ok(shapes.length >= 16, `low detail: ${shapes.length} shapes on ${building[0]?.name}`)
    const doors = shapes.filter((s) => s.type === 'door')
    const wins = shapes.filter((s) => s.type === 'window')
    a.ok(doors.length >= 3, `only ${doors.length} doors`)
    a.ok(wins.length >= 3, `only ${wins.length} windows`)
    const withDir = [...doors, ...wins].filter((s) => s.dir === 'h' || s.dir === 'v').length
    a.ok(withDir >= (doors.length + wins.length) * 0.6, `only ${withDir}/${doors.length + wins.length} openings carry wall orientation (dir)`)
    const overlaps = bpOverlaps(p)
    a.ok(overlaps.length === 0, `overlapping rooms: ${overlaps.join('; ')}`)
    a.ok((building[0]?.dimensions || []).length >= 2, 'not enough dimension lines')
    a.note(`${floors.length} floors, ${shapes.length} shapes, ${doors.length} doors/${wins.length} windows`)
  }),
  check('cad', async (a) => {
    const r = await invoke('api/cad.ts', { prompt: 'a detailed adjustable architect desk lamp with a weighted base, two arm segments with knurled adjustment knobs, springs, and a vented lamp head' })
    a.ok(r.status === 200, `status ${r.status}`)
    const code = r.json?.code || ''
    a.ok(code.length > 2500, `too little geometry: ${code.length}B`)
    a.ok((code.match(/module\s+\w+/g) || []).length >= 5, `only ${(code.match(/module\s+\w+/g) || []).length} modules`)
    a.ok(/\$fn\s*=/.test(code), 'no $fn resolution set')
    a.ok(!/minkowski/.test(code), 'uses minkowski (render-killer)')
    a.ok(/for\s*\(/.test(code), 'no repetition patterns (fasteners/knurling)')
    const open = (code.match(/\{/g) || []).length, close = (code.match(/\}/g) || []).length
    a.ok(open === close, `unbalanced braces ${open}/${close}`)
    a.note(`${(code.length / 1024).toFixed(1)}KB scad, ${(code.match(/module\s+\w+/g) || []).length} modules`)
  }),
  check('logo', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'Design a logo for Ember, a coastal coffee brand', kind: 'logo' })
    a.ok(r.status === 200, `status ${r.status}`)
    const p = r.json || {}
    a.ok(p.name === 'Ember', `name mangled: "${p.name}"`)
    a.ok(!!p.initials, 'no initials')
    a.ok(Array.isArray(p.colors) && p.colors.length >= 1, 'no colors')
    a.ok(typeof p.symbol === 'string' && p.symbol.length > 10, `no art-directed symbol concept: "${p.symbol}"`)
    a.ok(Array.isArray(p.colorNames) && p.colorNames.length >= 1, 'no diffusion-friendly color names')
    // the actual image pipeline: build the icon-only prompt and proxy-fetch it
    const prompt = `professional vector logo mark, a flat geometric pictorial mark: ${p.symbol}, modern, flat 2D vector illustration, ${p.colorNames?.[0] || 'deep navy'} on white, one single centered icon on a solid white background, NO text, NO letters, no watermark`
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&model=flux&seed=7`
    const pr = await invoke('api/web.ts', { action: 'proxyimg', url }, { timeoutMs: 300000 })
    a.ok(!!pr.json?.dataUrl, `logo image did not resolve: ${pr.json?.error || ''}`)
    a.note(`symbol: "${p.symbol}"`)
  }),
  check('palette', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'Create a color palette for a calm wellness app', kind: 'palette' })
    a.ok(r.status === 200, `status ${r.status}`)
    const colors = r.json?.colors || []
    a.ok(colors.length >= 5 && colors.length <= 8, `${colors.length} colors`)
    a.ok(colors.every((c) => /^#[0-9A-F]{6}$/i.test(c.hex)), 'invalid hex present')
    a.ok(colors.every((c) => c.role && c.name), 'missing role/name')
  }),
  check('brand-book', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'Create brand guidelines for Aurora, a fintech startup', kind: 'brand' })
    a.ok(r.status === 200, `status ${r.status}`)
    const html = r.json?.html || ''
    a.ok(/Aurora/.test(html), 'brand name missing')
    a.ok((html.match(/#[0-9A-Fa-f]{6}/g) || []).length >= 4, 'too few palette swatches')
    a.ok(/fonts.googleapis/i.test(html), 'no font loading')
    a.ok(html.length > 15000, `book too thin: ${html.length}B`)
  }),
  check('canvas', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'Make an editable social graphic for an Instagram post announcing a summer sale', kind: 'canvas' })
    a.ok(r.status === 200, `status ${r.status}`)
    const objs = r.json?.canvas?.objects || []
    a.ok(objs.length >= 8, `only ${objs.length} objects`)
    a.ok(objs.some((o) => o.type === 'textbox' && o.text && !/lorem/i.test(o.text)), 'no real text')
  }),
  check('shopping', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'Make a shopping list to furnish a mid-century living room under $4000', kind: 'shopping' })
    a.ok(r.status === 200, `status ${r.status}`)
    const items = r.json?.items || []
    a.ok(items.length >= 8 && items.length <= 16, `${items.length} items`)
    a.ok(items.every((it) => it.name && it.price && it.query), 'items missing name/price/query')
  }),
  check('poster', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'Design a poster for a summer jazz festival in Sausalito, July 18-20 2026, headliner Nina Reyes Quartet', kind: 'poster' })
    a.ok(r.status === 200, `status ${r.status}`)
    const html = r.json?.html || ''
    a.ok(/<\/html>\s*$/i.test(html.trim()), 'truncated poster')
    a.ok(/jazz/i.test(html), 'subject missing')
    a.ok(/Nina Reyes/i.test(html) || /Sausalito/i.test(html), 'the poster dropped the real event details')
    a.ok(/aspect-ratio|aspectRatio/i.test(html), 'no fixed poster artboard (renders as a webpage)')
    a.ok(!/<nav/i.test(html), 'has a nav bar — poster leaked into website layout')
    a.ok(html.length > 4000, `too thin: ${html.length}B`)
  }),
  check('walkthrough-blueprint', async (a) => {
    // The walkthrough is a blueprint driven through the 3D first-person view —
    // its quality bar is a walkable plan: doors on walls, openings per room.
    const r = await invoke('api/design.ts', { prompt: 'Design a house I can walk through in 3D: a 2-bedroom apartment with a balcony', kind: 'blueprint' })
    a.ok(r.status === 200, `status ${r.status}`)
    const p = r.json || {}
    const floors = Array.isArray(p.floors) ? p.floors : []
    const building = floors.filter((f) => !/site/i.test(f.name || ''))
    a.ok(building.length >= 1, 'no building floor')
    const shapes = building[0]?.shapes || []
    const rooms = shapes.filter((s) => s.type === 'rect' && s.label && s.w * s.h >= 40)
    const doors = shapes.filter((s) => s.type === 'door')
    a.ok(rooms.length >= 4, `only ${rooms.length} rooms`)
    a.ok(doors.length >= Math.max(2, rooms.length - 3), `only ${doors.length} doors for ${rooms.length} rooms — not walkable`)
    a.ok(bpOverlaps(p).length === 0, `overlapping rooms: ${bpOverlaps(p).join('; ')}`)
    a.note(`${rooms.length} rooms, ${doors.length} doors`)
  }),
  check('motion', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'Create an animated motion graphic for an Ember coffee logo reveal', kind: 'motion' })
    a.ok(r.status === 200, `status ${r.status}`)
    const html = r.json?.html || ''
    a.ok(/@keyframes|requestAnimationFrame/.test(html), 'no animation loop')
    a.ok(/<\/html>\s*$/i.test(html.trim()), 'truncated')
  }),
  check('game', async (a) => {
    const r = await invoke('api/design.ts', { prompt: 'Make a playable game: a simple endless runner where you dodge obstacles', kind: 'game' }, { timeoutMs: 300000 })
    a.ok(r.status === 200, `status ${r.status}`)
    const html = r.json?.html || ''
    a.ok(/playcanvas/i.test(html), 'not a PlayCanvas build')
    a.ok(html.length > 9000, `game too thin: ${html.length}B`)
    a.ok(/<\/html>\s*$/i.test(html.trim()), 'truncated game')
  }),
  check('document', async (a) => {
    const r = await invoke('api/doc.ts', { prompt: 'Write a polished document: a business plan for a mobile coffee cart in Denver' })
    a.ok(r.status === 200, `status ${r.status}`)
    const blocks = r.json?.blocks || []
    a.ok(blocks.length >= 10, `only ${blocks.length} blocks`)
    // count ALL content: paragraphs, headings, bullet items, table cells
    const words = blocks
      .flatMap((b) => [b.text || '', ...(b.items || []), ...((b.rows || []).flat?.() || []), ...(b.columns || [])])
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length
    a.ok(words > 400, `only ~${words} words of content`)
    a.ok(blocks.some((b) => b.type === 'table' || b.type === 'chart'), 'no tables/charts in a business plan')
    a.ok(!!r.json?.title, 'no title')
    a.note(`${blocks.length} blocks, ~${words} words`)
  }),
  check('spreadsheet', async (a) => {
    const r = await invoke('api/sheet.ts', { prompt: 'Build a spreadsheet for a monthly household budget with formulas totaling each category' })
    a.ok(r.status === 200, `status ${r.status}`)
    const sheets = r.json?.sheets || []
    a.ok(sheets.length >= 1, 'no sheets')
    const cells = JSON.stringify(sheets)
    a.ok((cells.match(/"=(SUM|AVERAGE|[A-Z]+\d+)/g) || []).length >= 5, 'too few live formulas')
    // multi-tab models put inputs on a small Assumptions tab — judge the DEEPEST tab
    const maxRows = Math.max(...sheets.map((s) => (s.rows || []).length))
    a.ok(maxRows >= 10, `deepest tab has only ${maxRows} rows`)
    a.note(`${sheets.length} tabs, deepest ${maxRows} rows`)
  }),
  check('slides', async (a) => {
    const r = await invoke('api/slides.ts', { prompt: 'Create a pitch deck about an AI note-taking app' })
    a.ok(r.status === 200, `status ${r.status}`)
    const slides = r.json?.slides || []
    a.ok(slides.length >= 8, `only ${slides.length} slides`)
    a.ok(slides.every((s) => s.title), 'slides missing titles')
    a.ok(slides.some((s) => s.chart || s.image || s.photo), 'no visual slides (chart/photo)')
  }),
  check('image', async (a) => {
    const r = await invoke('api/image.ts', { prompt: 'a misty pine forest at sunrise' })
    a.ok(r.status === 200, `status ${r.status}`)
    const url = r.json?.url || ''
    a.ok(/^https?:/.test(url), 'no image url')
    const ir = await fetch(url, { signal: AbortSignal.timeout(90000) })
    const buf = Buffer.from(await ir.arrayBuffer())
    a.ok(ir.ok && (ir.headers.get('content-type') || '').startsWith('image/') && buf.length > 10000, `image did not resolve (${ir.status}, ${buf.length}B)`)
    a.note(`${Math.round(buf.length / 1024)}KB image`)
  }),
  check('vision-chat', async (a) => {
    const dataUrl = 'data:image/jpeg;base64,' + readFileSync(PHOTO).toString('base64')
    const r = await invoke('api/chat.ts', { messages: [{ role: 'user', content: [
      { type: 'text', text: 'In 2-3 sentences: what exactly is shown in this image?' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] }] })
    const sse = r.sse || ''
    a.ok(/"kind":"vision"/.test(sse), 'did not route to the vision specialist')
    const text = [...sse.matchAll(/event: delta\ndata: (.+)/g)].map((m) => { try { return JSON.parse(m[1]).text } catch { return '' } }).join('')
    a.ok(text.length > 40, `no answer streamed (${text.length} chars)`)
    a.ok(/hous|architect|casa|design|board|render|floor plan|social|post/i.test(text), `answer does not reflect the photo: "${text.slice(0, 140)}"`)
    a.ok(!/can'?t\s+(see|view)|cannot\s+(see|view)/i.test(text), 'still claims it cannot see images')
    a.note(text.slice(0, 110).replace(/\s+/g, ' '))
  }),
  check('video', async (a) => {
    const r = await invoke('api/video.ts', { prompt: 'a slow ocean wave at golden hour' }, { timeoutMs: 300000 })
    if (r.status !== 200 && /not configured|no video (provider|backend)|configure|busy|try again/i.test(r.json?.error || '')) {
      a.note(`SKIP — video provider unavailable right now (${(r.json?.error || '').slice(0, 90)})`)
      return
    }
    a.ok(r.status === 200, `status ${r.status}: ${r.json?.error || ''}`)
    a.ok(/^https?:|^data:/.test(r.json?.url || ''), 'no video url')
  }, { hard: false }),
]

// ---------- runner ----------
const filter = process.argv[2]
const list = CHECKS.filter((c) => !filter || c.name.includes(filter))
// Interleave the heavy long-generation checks (websites/board/blueprint/game)
// between light ones so they never run all-at-once and saturate the provider.
const HEAVY = /website|board|blueprint|game/
const heavy = list.filter((c) => HEAVY.test(c.name))
const light = list.filter((c) => !HEAVY.test(c.name))
const ordered = []
while (heavy.length || light.length) {
  const h = heavy.shift(); if (h) ordered.push(h)
  for (let i = 0; i < 3; i++) { const l = light.shift(); if (l) ordered.push(l) }
}
list.length = 0; list.push(...ordered)
console.log(`Running ${list.length} studio quality checks…\n`)
const CONC = 3
let failHard = 0
const queue = [...list]
await Promise.all(Array.from({ length: CONC }, async () => {
  for (;;) {
    const c = queue.shift()
    if (!c) return
    const a = new Asserts()
    const t0 = Date.now()
    try { await c.fn(a) } catch (e) { a.fails.push(`threw: ${e instanceof Error ? e.message : e}`) }
    const dur = ((Date.now() - t0) / 1000).toFixed(0)
    const pass = a.fails.length === 0
    if (!pass && c.hard) failHard++
    results.push({ name: c.name, pass, fails: a.fails, notes: a.notes, dur })
    console.log(`${pass ? 'PASS' : c.hard ? 'FAIL' : 'WARN'}  ${c.name} (${dur}s)${a.notes.length ? ` — ${a.notes.join(' · ')}` : ''}`)
    for (const f of a.fails) console.log(`      ✗ ${f}`)
  }
}))
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed${failHard ? ` — ${failHard} HARD FAILURES` : ''}`)
process.exit(failHard ? 1 : 0)
