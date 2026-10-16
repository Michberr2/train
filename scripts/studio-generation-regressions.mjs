// Uses the real completion/continuation code with a virtual clock and fake fetch.
// No provider calls, credentials or wall-clock sleeps. Run with node.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { memoCommitmentFindings } from './studio-live-validation.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(root, 'scripts', '.studio-generation-'))
const original = { now: Date.now, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
const envKeys = ['TINKER_API_KEY', 'NALU_FALLBACK_API_KEY', 'GEMINI_API_KEY', 'NALU_DISABLE_EMERGENCY']
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
try {
  process.env.TINKER_API_KEY = 'offline-test-primary'
  process.env.NALU_FALLBACK_API_KEY = 'offline-test-fallback'
  process.env.GEMINI_API_KEY = 'offline-test-emergency'
  delete process.env.NALU_DISABLE_EMERGENCY
  const result = await build({
    stdin: { resolveDir: root, contents: `
      export { generateStudioJson } from './api/_studioGeneration';
      export { STUDIO_FIDELITY } from './api/_studioInstructions';
      export { DOC_FIDELITY, normalizeDocumentBlocks } from './api/_docFidelity';
      export { studioMediaPreference } from './api/_studioMedia';
      export { default as doc } from './api/doc';
      export { default as slides } from './api/slides';
    ` },
    bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'offline-services', setup(build) {
      build.onResolve({ filter: /^\.\/_db$|^\.\/_limits$|^\.\/_grounding$|^\.\/_accountContext$/ }, (args) => ({ path: args.path, namespace: 'offline' }))
      build.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents:
        path === './_accountContext' ? 'export async function accountContextForUser(){return ""}' :
        path === './_db' ? 'export async function identityForRequest() { return globalThis.__studioClock.identity || null }; export function identityBlock(who) { return who ? `SIGNED-IN USER: ${who.name}` : "" }' :
        path === './_grounding' ? 'export async function groundResearch() { globalThis.__studioClock.time += globalThis.__studioClock.preparationMs; return { text: globalThis.__studioClock.grounding || "", sources: globalThis.__studioClock.sources || [], status: globalThis.__studioClock.sources ? "verified-sources" : "not-needed", checkedAt: "2026-09-12" } }; export async function groundFromPrompt() { return (await groundResearch()).text }' :
        'export async function reserveStudioQuota() { return { ok: true, release: async () => { globalThis.__studioClock.releases++ } } }; export function studioLimitMessage() { return "limit" }',
      }))
    } }],
  })
  const modulePath = join(temp, 'generation.mjs')
  await writeFile(modulePath, result.outputFiles[0].text)
  const { generateStudioJson, STUDIO_FIDELITY, DOC_FIDELITY, normalizeDocumentBlocks, studioMediaPreference, doc, slides } = await import(pathToFileURL(modulePath).href)
  let clock
  let sequence = 0
  const timers = new Map()
  const reset = (responses = [], preparationMs = 0) => {
    timers.clear()
    clock = { time: 0, calls: [], responses, releases: 0, preparationMs }
    globalThis.__studioClock = clock
  }
  Date.now = () => clock.time
  globalThis.setTimeout = (callback, ms) => { const id = ++sequence; timers.set(id, { callback, ms }); return id }
  globalThis.clearTimeout = (id) => { timers.delete(id) }
  globalThis.fetch = async (url, init) => {
    const timer = [...timers.values()].at(-1)
    assert.ok(timer, 'every model call must have a live watchdog')
    const response = clock.responses.shift() || { timeout: true }
    clock.calls.push({ url, body: JSON.parse(init.body), timeout: timer.ms })
    if (response.timeout) {
      clock.time += timer.ms
      timer.callback()
      assert.ok(init.signal.aborted, 'watchdog must cancel the upstream request')
      throw new DOMException('aborted', 'AbortError')
    }
    clock.time += response.slow ? timer.ms - 1 : 100
    return {
      ok: !response.status, status: response.status || 200,
      text: async () => 'rate limited',
      json: async () => ({ choices: [{ message: { content: response.content || '{"ok":true}' }, finish_reason: response.finish || 'stop' }] }),
    }
  }
  const options = () => ({ model: 'test-model', deadlineMs: 250000, maxTokens: 16000, temperature: 0.4, messages: (attempt) => [{ role: 'user', content: `attempt ${attempt}` }], parse: (text) => JSON.parse(text) })

  reset([{ status: 429 }, { content: '{"ok":true}' }])
  assert.deepEqual(await generateStudioJson(options()), { ok: true })
  assert.equal(clock.calls.length, 2, 'rate limits must not trigger hidden retries')
  assert.notEqual(clock.calls[0].url, clock.calls[1].url, 'failure must reach the fallback provider')

  reset([{ content: '{"ok":', finish: 'length' }, { content: 'true}' }])
  assert.deepEqual(await generateStudioJson(options()), { ok: true })
  assert.equal(clock.calls.length, 2)
  assert.equal(clock.calls[0].url, clock.calls[1].url)
  assert.match(clock.calls[1].body.messages.at(-1).content, /Continue exactly/)

  reset([{ content: '{', finish: 'length', slow: true }, { timeout: true }, { content: '{', finish: 'length', slow: true }, { timeout: true }])
  assert.equal(await generateStudioJson(options()), null)
  assert.ok(clock.time <= 240000, `continuations exceeded request budget: ${clock.time}`)
  assert.equal(clock.calls.length, 4)
  assert.ok(clock.calls[2].timeout < clock.calls[0].timeout)
  assert.equal(timers.size, 0, 'finished calls must release every watchdog')

  reset()
  clock.time = 245000
  assert.equal(await generateStudioJson(options()), null)
  assert.equal(clock.calls.length, 0, 'expired requests must not start more work')

  const invoke = async (handler, body) => {
    const res = { code: 200, payload: null, setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload; return this } }
    await handler({ method: 'POST', headers: {}, body: { prompt: 'Create a report', ...body } }, res)
    return res
  }
  for (const [handler, body] of [[doc, {}], [doc, { mode: 'outline' }], [doc, { mode: 'section' }], [slides, {}]]) {
    reset([], 25000)
    const response = await invoke(handler, body)
    assert.equal(response.code, 502)
    assert.equal(clock.releases, 1, 'failed generation must refund its quota slot')
    assert.ok(clock.time <= 240000, `endpoint exceeded generation deadline: ${clock.time}`)
    assert.equal(new Set(clock.calls.map((call) => call.url)).size, 3, 'each provider should get a bounded chance: ' + JSON.stringify({body,response,time:clock.time}))
  }

  // Account for source-reading time BEFORE generation; do not reset the deadline.
  reset([{ content: '{', finish: 'length', slow: true }, { timeout: true }], 60000)
  assert.equal((await invoke(doc, {})).code, 502)
  assert.ok(clock.time <= 240000)

  // Prompt contract: inspect the ACTUAL outgoing model messages in each mode,
  // including malformed-JSON retries and revisions. Editorial instructions must
  // never replace explicit structure, wording or the source of factual claims.
  const promptCases = [
    [doc, { prompt: 'A memo titled "review & decide" with only two sections: "what stays?" and "next move". Maximum 180 words. No deadlines.' }, '{"blocks":[{"type":"paragraph","text":"Ready"}]}'],
    [doc, { prompt: 'Change only the heading "next move" to "decisions".', prevDoc: JSON.stringify({ title: 'review & decide', blocks: [{ type: 'heading', text: 'next move' }, { type: 'paragraph', text: 'Keep this content.' }] }) }, '{"blocks":[{"type":"paragraph","text":"Ready"}]}'],
    [doc, { mode: 'outline', prompt: 'Plan four sections for a guide, retaining the supplied headings exactly: "start", "practice", "check", "repeat".' }, '{"chapters":[{"heading":"start","brief":"Begin here.","targetWords":100}]}'],
    [doc, { mode: 'section', prompt: 'Keep the supplied section heading exactly and do not invent figures.', heading: 'costs & choices', docTitle: 'A practical guide', brief: 'Explain tradeoffs.' }, '{"blocks":[{"type":"heading","text":"costs & choices"}]}'],
    [slides, { prompt: 'Four content slides with titles "start", "practice", "check", "repeat", one bullet each. No photos or estimates.' }, JSON.stringify({ slides: ['start', 'practice', 'check', 'repeat'].map((title) => ({ title, bullets: ['Begin'] })) })],
    [slides, { prompt: 'Change only the title "start" to "begin here".', prevDeck: JSON.stringify({ title: 'A practical guide', slides: [{ title: 'start', bullets: ['Keep this instruction.'] }] }) }, '{"slides":[{"title":"begin here","bullets":["Keep this instruction."]}]}'],
    [slides, { prompt: 'A short training deck about listening during team meetings. No financial analysis.' }, '{"slides":[{"title":"Listen","bullets":["Hear each speaker."]}]}', false],
    [slides, { prompt: 'A two-slide investor pitch for a new service. No metrics have been supplied; identify missing financial inputs without estimating them.' }, '{"slides":[{"title":"Inputs needed","bullets":["Customer counts and contract values."]}]}', true],
  ]
  assert.match(STUDIO_FIDELITY, /VERBATIM, including capitalization and punctuation/)
  assert.match(STUDIO_FIDELITY, /section\/slide counts, titles, headings, order, bullet counts, length limits/)
  assert.match(STUDIO_FIDELITY, /Never invent deadlines, effective dates, promised actions, company facts/)
  assert.match(STUDIO_FIDELITY, /Action items and next steps are RECOMMENDATIONS/)
  assert.match(STUDIO_FIDELITY, /Do not assert that an organization will schedule a meeting/)
  for (const [handler, body, content, financial] of promptCases) {
    reset([{ content: '{' }, { content: '{' }, { content }, ...(body.prevDoc ? [{content}] : [])])
    assert.equal((await invoke(handler, body)).code, 200)
    assert.equal(clock.calls.length, body.prevDoc ? 4 : 3, 'exercise every retry prompt and revision review')
    for (const call of clock.calls.slice(0, 3)) {
      const system = call.body.messages.find((message) => message.role === 'system').content
      const user = call.body.messages.find((message) => message.role === 'user').content
      assert.ok(system.endsWith(STUDIO_FIDELITY), 'fidelity contract must follow style, experts and retry guidance')
      if (handler === doc) assert.ok(system.includes(DOC_FIDELITY), 'every document mode/retry must distinguish title metadata and supported authorship')
      assert.doesNotMatch(system, /no heading-on-every-line|Each slide title should be a MESSAGE|Each "title" is the TAKEAWAY|keep it focused \(5–6 sections\)|concise \(4–5 sections\)|never invent or omit a date|use it for any dates, timelines/)
      assert.doesNotMatch(system, /MANDATORY FINANCIALS|the deck MUST carry|See the CHART MANDATE|Never emit vague or round-only placeholder data/)
      if (financial !== undefined) {
        assert.equal(system.includes('FINANCIAL REVIEW (Nalu Financial)'), financial, 'a generic deck must not be treated as an investor pitch')
        if (financial) assert.match(system, /If inputs are missing, name what is needed/)
      }
      assert.ok(user.includes(body.prompt), 'the original request must reach every provider unchanged')
      if (body.prevDoc) assert.ok(user.includes(body.prevDoc), 'document revisions must retain the original artifact')
      if (body.prevDeck) assert.ok(user.includes(body.prevDeck), 'deck revisions must retain the original artifact')
      if (body.heading) assert.ok(user.includes(body.heading), 'section generation must retain the exact outline heading')
      assert.ok(call.timeout <= 90000, 'prompt changes must not remove generation watchdogs')
    }
  }

  // Actual document handler output, deliberately noncompliant model responses:
  // metadata already renders the title, but user-specified sections and headers
  // carry meaning and must survive normal, revision and long-form generation.
  const memo = {
    title: 'Dispatch notes',
    blocks: [
      { type: 'heading', level: 1, text: 'Dispatch notes' },
      { type: 'paragraph', text: 'To: Dispatch team\nFrom: Coordination Office\nDate: April 2, 2025\nSubject: Dispatch notes' },
      { type: 'heading', level: 2, text: 'Purpose' },
      { type: 'paragraph', text: 'Describe the verified status. Review priorities for the coming week.' },
    ],
  }
  reset([{ content: JSON.stringify(memo) }])
  let response = await invoke(doc, { prompt: 'Write a memo titled "Dispatch notes" with the section "Purpose". Do not invent a sender.' })
  assert.equal(response.code, 200)
  assert.equal(response.payload.title, memo.title)
  assert.deepEqual(response.payload.blocks, [
    { ...memo.blocks[1], text: 'To: Dispatch team\nDate: April 2, 2025\nSubject: Dispatch notes' }, ...memo.blocks.slice(2),
  ], 'remove only redundant title and unsupported sender; preserve other header/prose content')

  const headerCases = [
    ['Write a memo from Lena Ortiz in Operations.', 'Lena Ortiz, Operations', true],
    ['Write a memo from Renée O’Neil.', 'Renée O’Neil', true],
    ['Use From: Alex Chen <alex@example.test>.', 'Alex Chen <alex@example.test>', true],
    ['Write a memo from Lena Ortiz.', 'Lena Ortiz-Smith', false],
    ['Write a generic memo.', '[Sender Name], [Department]', true],
    ['Write a generic memo. Do not invent sender names.', 'Coordination Office', false],
    ['Write a fictional memo with a made-up sender.', 'Morgan Bell', true],
    ['Write a memo. Avoid fictional sender names.', 'Morgan Bell', false],
  ]
  for (const [prompt, sender, retain] of headerCases) {
    const blocks = [{ type: 'paragraph', text: `From: ${sender}\nSubject: Update` }, { type: 'paragraph', text: 'Review the update.' }]
    reset([{ content: JSON.stringify({ title: 'Update', blocks }) }])
    response = await invoke(doc, { prompt })
    assert.equal(response.code, 200)
    assert.equal(response.payload.blocks[0].text, retain ? blocks[0].text : 'Subject: Update', prompt)
  }

  reset([{ content: JSON.stringify(memo) }])
  clock.grounding = 'SUPPLIED SOURCE: From: Coordination Office\n'
  response = await invoke(doc, { prompt: 'Write a memo using the supplied source.' })
  assert.match(response.payload.blocks[0].text, /From: Coordination Office/, 'preserve source-supported sender')

  for (const prompt of ['Write a memo from me.', 'Write a generic memo.']) {
    reset([{ content: JSON.stringify({ title: 'Update', blocks: [{ type: 'paragraph', text: 'From: Riley Chen\nSubject: Update' }, { type: 'paragraph', text: 'Review status.' }] }) }])
    clock.identity = { name: 'Riley Chen' }
    response = await invoke(doc, { prompt })
    assert.equal(response.payload.blocks[0].text.includes('From:'), prompt.includes('from me'), 'profile personalization must not automatically assign authorship')
  }

  for (const prompt of [
    'Write a memo titled "Dispatch notes" with sections "Dispatch notes" and "Purpose".',
    'Use "Dispatch notes" as the title. Repeat the title in the body as a heading.',
    'Write "Dispatch notes" with an opening section heading matching the title.',
  ]) {
    reset([{ content: JSON.stringify(memo) }])
    response = await invoke(doc, { prompt })
    assert.deepEqual(response.payload.blocks[0], memo.blocks[0], prompt)
  }
  for (const prompt of ['Write a memo. Do not repeat the title in the body.', 'Write a memo. Never include the title as a heading.']) {
    reset([{ content: JSON.stringify(memo) }])
    response = await invoke(doc, { prompt })
    assert.notEqual(response.payload.blocks[0].type, 'heading', 'a prohibition against repetition is not permission to preserve the duplicate')
  }
  reset([{ content: JSON.stringify(memo) }, { content: JSON.stringify(memo) }])
  response = await invoke(doc, { prompt: 'Change only the body wording.', prevDoc: JSON.stringify(memo) })
  assert.deepEqual(response.payload.blocks, memo.blocks, 'an unrelated revision must preserve existing title/header content')

  const section = { blocks: [{ type: 'heading', level: 1, text: 'Dispatch notes' }, { type: 'heading', level: 1, text: 'Purpose' }, { type: 'paragraph', text: 'From: Lena Ortiz\nSubject: Update' }, { type: 'paragraph', text: 'Review the update.' }] }
  reset([{ content: JSON.stringify(section) }])
  const longPrompt = 'Write a long work. '.repeat(100) + 'Preserve From: Lena Ortiz.'
  clock.grounding = 'SOURCE HEADER: From: Lena Ortiz\n'
  response = await invoke(doc, { mode: 'section', prompt: longPrompt, heading: 'Purpose', docTitle: 'Dispatch notes' })
  assert.deepEqual(response.payload.blocks, section.blocks.slice(1), 'remove the overall title, preserving the fixed chapter heading and sender')
  assert.ok(clock.calls[0].body.messages[1].content.includes(longPrompt), 'long-form generation must retain instructions beyond character 1,500')
  assert.ok(clock.calls[0].body.messages[1].content.includes(clock.grounding), 'section providers must receive the fetched source, not just normalizers')
  reset([{ content: JSON.stringify(memo) }])
  response = await invoke(doc, { mode: 'section', prompt: 'Write the supplied section.', heading: 'Dispatch notes', docTitle: 'Dispatch notes', brief: 'Preserve From: Coordination Office.' })
  assert.deepEqual(response.payload.blocks, memo.blocks, 'a chapter can intentionally share the work title and contain supplied correspondence')
  const outline = { title: 'Dispatch notes', chapters: [{ heading: 'Dispatch notes', brief: 'Keep the supplied From: Lena Ortiz header.', targetWords: 200 }] }
  reset([{ content: JSON.stringify(outline) }])
  response = await invoke(doc, { mode: 'outline', prompt: 'Use "Dispatch notes" as both title and chapter heading. Preserve From: Lena Ortiz.' })
  assert.deepEqual(response.payload.chapters, outline.chapters, 'do not remove meaningful outline chapters as if they were duplicate body formatting')

  const narrative = [{ type: 'paragraph', text: 'From: the doorway, she called for help. This is quoted narrative.' }, { type: 'heading', text: 'Dispatch notes' }]
  assert.deepEqual(normalizeDocumentBlocks(narrative, { title: 'Dispatch notes', prompt: 'Write a story.' }), narrative, 'do not edit prose or later same-name headings')
  reset([{ content: JSON.stringify({ title: { text: 'Dispatch notes' }, blocks: narrative }) }])
  assert.equal((await invoke(doc, { prompt: 'Write a story.' })).code, 200, 'formatting guard must not crash on recoverable malformed model title values')

  reset([{ content: JSON.stringify({ title: 'Research brief', blocks: [{ type: 'paragraph', text: 'A claim [invented source](https://fake.example/report).' }] }) }, { content: JSON.stringify({ title: 'Research brief', blocks: [{ type: 'paragraph', text: 'An observation [official source](https://agency.gov/report).' }] }) }])
  clock.sources = [{ title: 'Official source', url: 'https://agency.gov/report', status: 'read', accessedAt: '2026-09-12T12:00:00Z', publishedAt: '2026-08-20' }]
  clock.grounding = 'Source: https://agency.gov/report. An observation was reported.'
  clock.responses.push({ content: JSON.stringify({ title: 'Research brief', blocks: [{ type: 'paragraph', text: 'An observation was reported [1].' }] }) })
  response = await invoke(doc, { prompt: 'Write a researched brief about the supplied observation.' })
  assert.equal(response.code, 200); assert.equal(clock.calls.length, 3)
  assert.deepEqual(response.payload.sources, clock.sources)
  assert.match(clock.calls[1].body.messages[0].content, /previous output cited a URL/)
  assert.match(clock.calls[2].body.messages[0].content, /Check EVERY externally sourced claim/)
  assert.match(response.payload.blocks[0].text, /\[Official source\]\(https:\/\/agency.gov\/report\)/)
  assert.deepEqual(memo.blocks[0], { type: 'heading', level: 1, text: 'Dispatch notes' }, 'normalization must not mutate its input')

  const timingAdvice = [
    'Top three priorities for the coming week.',
    'Review priorities for next month.',
    'Consider scheduling a review next week.',
    'A review could be scheduled next week.',
    'If a review will be scheduled next week, prepare an agenda.',
    'No review meeting will be scheduled next week.',
    'Do not claim a meeting will be scheduled next week.',
    'Adopt this format for all updates beginning next reporting cycle.',
  ]
  for (const sentence of timingAdvice) assert.deepEqual(memoCommitmentFindings(sentence), { promisedActions: [], relativeDeadlines: [] }, sentence)
  for (const sentence of [
    'A brief review session will be scheduled next week.',
    'Operations will adopt the template by next Monday.',
    'A review has been scheduled for next week.',
    'The deadline is next Friday.',
    'Reports are due within two days.',
    'The policy takes effect next month.',
    'No later than next Monday, the template will be adopted.',
  ]) {
    const finding = memoCommitmentFindings(sentence)
    assert.equal(finding.promisedActions.length, 1, sentence)
    assert.ok(finding.relativeDeadlines.length > 0, sentence)
  }

  // Content-valid JSON can still make an unsupported operational promise. The
  // real endpoint must reject that candidate and retry under its SAME budget,
  // never silently delete prose or return a successful fabricated commitment.
  const promiseCases = [
    'Training materials will be circulated as needed.',
    'Additional support shall be provided on request.',
    'The packet will soon be sent.',
    'Resources will be made available.',
    'An updated guide will be published.',
    'If needed, a briefing will be arranged.',
    "We'll contact the team.",
    'A project coordinator will prepare the next update.',
    'Further guidance or templates will be shared as needed to facilitate this process.',
  ]
  const memoPayload = (text) => ({ title: 'A practical update', blocks: [{ type: 'heading', level: 1, text: 'Next steps' }, { type: 'paragraph', text }] })
  const recommendation = 'Review the verified status. Consider sharing a reference guide if it would help.'
  for (const promise of promiseCases) {
    assert.equal(memoCommitmentFindings(promise).promisedActions.length, 1, promise)
    reset([{ content: JSON.stringify(memoPayload(promise)) }, { content: JSON.stringify(memoPayload(recommendation)) }])
    response = await invoke(doc, { prompt: 'Write a short internal memo with practical next steps.' })
    assert.equal(response.code, 200)
    assert.equal(clock.calls.length, 2, 'structurally valid but unsupported promise must use a bounded retry')
    assert.deepEqual(response.payload.blocks, memoPayload(recommendation).blocks, 'return the corrected complete artifact; do not scrub individual sentences')
    assert.match(clock.calls[1].body.messages[0].content, /CONTENT CORRECTION/)
    assert.equal(clock.releases, 0)
  }

  for (const [body, badContent] of [
    [{}, memoPayload(promiseCases[0])],
    [{ mode: 'outline' }, { title: 'Team letter', chapters: [{ heading: 'Next steps', brief: promiseCases[0], targetWords: 200 }] }],
    [{ mode: 'section', heading: 'Next steps', docTitle: 'Team letter' }, memoPayload(promiseCases[0])],
  ]) {
    reset(Array.from({ length: 3 }, () => ({ content: JSON.stringify(badContent), slow: true })))
    response = await invoke(doc, { prompt: 'Draft an internal letter about clear updates.', ...body })
    assert.equal(response.code, 502)
    assert.match(response.payload.error, /unsupported commitments/)
    assert.equal(clock.calls.length, 3, 'content validation cannot add attempts beyond existing JSON/provider retry cap')
    assert.equal(clock.releases, 1)
    assert.ok(clock.time <= 240000, 'content retries must retain the original deadline and cleanup margin')
  }

  const suppliedPromise = 'Operations will share the reference guide on Friday.'
  const passivePromise = 'The reference guide will be shared by Operations on Friday.'
  for (const [prompt, text, extra] of [
    [`Write a memo announcing this commitment: ${suppliedPromise}`, passivePromise, {}],
    ['Write a letter with the approved plan: Morgan sends the checklist on Friday.', 'The checklist will be sent by Morgan on Friday.', {}],
    ['Write a memo stating the deadline: Updates are due Friday.', 'Updates are due Friday.', {}],
    ['Write a fictional letter about a team preparing for a voyage.', promiseCases[0], {}],
    ['Change only the title of this memo.', suppliedPromise, { prevDoc: JSON.stringify(memoPayload(suppliedPromise)) }],
    ['Write an internal memo using the supplied source.', suppliedPromise, { grounded: suppliedPromise }],
    ['Write a memo with practical recommendations.', recommendation, {}],
    ['Write a memo about the benefits of clear updates.', 'Consistent formatting will improve communication and make reviews easier.', {}],
  ]) {
    reset([{ content: JSON.stringify(memoPayload(text)) }, ...(extra.prevDoc ? [{content: JSON.stringify(memoPayload(text))}] : [])])
    clock.grounding = extra.grounded || ''
    response = await invoke(doc, { prompt, prevDoc: extra.prevDoc })
    assert.equal(response.code, 200, prompt)
    assert.equal(clock.calls.length, extra.prevDoc ? 2 : 1, prompt)
    assert.deepEqual(response.payload.blocks, memoPayload(text).blocks, 'preserve supplied plans/deadlines, fiction, revision content and recommendations')
  }
  for (const prompt of [
    'Write a memo. Do not promise that training materials will be circulated as needed.',
    'Write a memo recommending that Operations should share the reference guide on Friday.',
    'Write a memo. Do not invent fictional promises.',
  ]) {
    reset([{ content: JSON.stringify(memoPayload(prompt.includes('Operations') ? suppliedPromise : promiseCases[0])) }, { content: JSON.stringify(memoPayload(recommendation)) }])
    response = await invoke(doc, { prompt })
    assert.equal(response.code, 200)
    assert.equal(clock.calls.length, 2, 'a prohibition or recommendation is not a source for an asserted commitment')
  }

  // Explicit media opt-outs must be enforced even if a model ignores the prompt.
  const mediaCases = [
    ['No photos.', true, true], ['Without any images.', true, true], ['Make this text-only.', true, true],
    ['Do not include pictures.', true, true], ["Don't generate any illustrations.", true, false],
    ['Stock photos are not needed.', true, false], ['No invented metrics, citations, or external photos are needed.', true, false],
    ['Use only attached images.', true, false], ['Only include the uploaded pictures.', true, false],
    ['No external photos; keep my images.', true, false], ['Remove the attached images.', false, true],
    ['Include photos.', false, false], ['Do not remove photos.', false, false], ['No need to remove images.', false, false],
    ['Not text-only; add photos.', false, false], ['Use no fewer than three photos.', false, false],
    ['There are no photos in the source.', false, false], ['No photos of identifiable children.', false, false],
    ['No statistics are needed, but include photos.', false, false], ['No photos. Add photos after all.', false, false],
  ]
  for (const [prompt, omitGenerated, omitAttached] of mediaCases) {
    assert.deepEqual(studioMediaPreference(prompt), { omitGenerated, omitAttached }, prompt)
    const content = '{"cover":"unrequested stock photograph","slides":[{"title":"Overview","layout":"image-text","image":"unrequested image prompt","bullets":["Useful content"]}]}'
    reset([{ content }])
    const response = await invoke(slides, { prompt })
    assert.equal(response.code, 200)
    assert.equal(response.payload.cover, omitGenerated ? '' : 'unrequested stock photograph', prompt)
    assert.equal(response.payload.slides[0].image, omitGenerated ? '' : 'unrequested image prompt', prompt)
    if (omitGenerated) {
      assert.equal(response.payload.slides[0].layout, 'bullets')
      assert.match(clock.calls[0].body.messages[0].content, /Set cover and every generated image prompt to ""/)
    }
  }
  const oldImage = { type: 'image', src: 'data:image/png;base64,cHJldmlvdXM=', caption: 'Existing image' }
  const documentImages = JSON.stringify({ title: 'Media handling', blocks: [
    { type: 'paragraph', text: 'The report content.' }, { type: 'image', ref: 0, caption: 'User attachment' }, oldImage,
    { type: 'image', src: 'https://example.invalid/generated-photo.jpg', caption: 'Generated image' },
  ] })
  for (const [prompt, expectedImages] of [['No external photos; retain the attached images.', 2], ['Text-only, without images.', 0], ['Include images.', 3]]) {
    reset([{ content: documentImages }, { content: documentImages }])
    const response = await invoke(doc, { prompt, images: [{ caption: 'A supplied diagram' }], prevDoc: JSON.stringify({ title: 'Earlier report', blocks: [oldImage] }) })
    assert.equal(response.code, 200)
    assert.equal(response.payload.blocks.filter((block) => block.type === 'image').length, expectedImages)
    assert.equal(response.payload.mediaPreference.omitAttached, expectedImages === 0)
  }

  delete process.env.TINKER_API_KEY
  for (const [handler, content] of [[doc, '{"blocks":[{"type":"paragraph","text":"Ready"}]}'], [slides, '{"slides":[{"title":"Ready","bullets":["Done"]}]}']]) {
    reset([{ content }])
    assert.equal((await invoke(handler, {})).code, 200, 'configured fallback should work without a primary key')
    assert.equal(clock.releases, 0)
  }
  console.log('PASS: provider failover, rate-limit attempt cap, continuation, shared 250s request deadline with 10s cleanup margin, all doc modes/slides quota refunds, fallback-only configuration, prompt fidelity across modes/revisions/retries, document title/header normalization and preservation, long-form source fidelity, supported versus invented senders, passive/active memo commitment retries with preserved source facts/plans/revisions/fiction, 20 media preference phrases, enforced photo opt-outs and preserved attachments.')
} finally {
  Date.now = original.now
  globalThis.fetch = original.fetch
  globalThis.setTimeout = original.setTimeout
  globalThis.clearTimeout = original.clearTimeout
  delete globalThis.__studioClock
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(temp, { recursive: true, force: true })
}
