import browserHost from '../browser-host/adapter.mjs'
import { validateAction, webUrl, id } from './policy.mjs'

// A browser process/profile per account AND agent. Mouse and keyboard events
// target that process; they never move the operating system's physical mouse.
export class DeviceRuntime {
  agents = new Map()
  constructor({ decide, host = browserHost } = {}) { this.decide = decide; this.host = host }
  agent(owner, name = 'main') {
    if (!id(name)) throw Error('Invalid agent.')
    const key = JSON.stringify([owner, name])
    if (!this.agents.has(key)) {
      if (this.agents.size >= 1000) throw Error('This device has reached its agent limit.')
      this.agents.set(key, { key, owner, name, epoch: 0, chain: Promise.resolve(), status: 'idle', history: [], page: null })
    }
    return this.agents.get(key)
  }
  state(a) {
    return { configured: true, runtime: 'device', agent_id: a.name, active: !!a.browser, status: a.status,
      task: a.task, result: a.result, steps: a.history.map(h => h.result), detail: a.detail,
      agents: [...this.agents.values()].filter(b => b.owner === a.owner).map(b => ({ id: b.name, status: b.status, active: !!b.browser })) }
  }
  serial(a, fn) {
    const next = a.chain.catch(() => {}).then(fn)
    a.chain = next.catch(() => {})
    return next
  }
  async open(a, url) {
    if (url) webUrl(url)
    if (!a.browser) {
      const endpoint = { owner: a.key }
      const acquired = await this.host.acquire(endpoint)
      a.browser = await this.host.connect(endpoint, acquired.sessionId)
      a.sessionId = acquired.sessionId
      a.page = (await a.browser.pages())[0] || await a.browser.newPage()
    }
    if (url) await a.page.goto(webUrl(url), { waitUntil: 'domcontentloaded', timeout: 25000 })
  }
  async request(owner, action, data = {}) {
    const a = this.agent(owner, data.agent_id || 'main')
    // Invalidate inference before waiting for any in-flight input to settle.
    if (['workspace_takeover', 'workspace_close'].includes(action)) {
      a.epoch++; a.controller?.abort(); delete a.queued; a.status = 'paused'
    }
    return this.serial(a, async () => {
      if (a.revoked) throw Error('Device disconnected.')
      if (action === 'workspace_status') return this.state(a)
      if (action === 'workspace_takeover') { a.detail = 'You have control. Sign in or help, then choose Continue.'; return this.state(a) }
      if (action === 'workspace_close') {
        if (a.browser) await a.browser.close()
        a.browser = null; a.page = null; a.status = 'idle'; setTimeout(() => void this.pump(), 0); return this.state(a)
      }
      if (action === 'workspace_screen') {
        if (!a.page || a.page.isClosed()) return { ...this.state(a), image: null }
        return { ...this.state(a), tabs: await Promise.all((await a.browser.pages()).map(async (p, index) => ({ index, title: await p.title(), active: p === a.page }))), cursor: a.cursor, image: 'data:image/jpeg;base64,' + await a.page.screenshot({ type: 'jpeg', quality: 65, encoding: 'base64' }), url: a.page.url(), width: 1440, height: 900 }
      }
      if (action === 'workspace_tab') {
        if (a.status === 'running' || !a.browser) throw Error('Take control before changing tabs.')
        const pages = await a.browser.pages()
        if (data.operation === 'new') {
          if (pages.length >= 12) throw Error('Close a tab before opening another.')
          const url = webUrl(data.url); a.page = await a.browser.newPage(); await a.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
        } else if (data.operation === 'switch' && Number.isInteger(data.index) && pages[data.index]) a.page = pages[data.index]
        else if (data.operation === 'close' && pages.length > 1) { await a.page.close(); a.page = (await a.browser.pages()).at(-1) }
        else throw Error('Invalid tab action.')
        return this.state(a)
      }
      if (action === 'workspace_input') {
        if (a.status === 'running' || !a.page) throw Error('Take control before interacting.')
        if (data.kind === 'text' && typeof data.text === 'string' && data.text.length <= 12000) await a.page.keyboard.type(data.text)
        else if (data.kind === 'click') { validateAction({ type: 'click_at', x: data.x, y: data.y }, 0, 0); a.cursor = { x: data.x, y: data.y }; await a.page.mouse.click(data.x, data.y) }
        else if (data.kind === 'scroll' && Number.isFinite(data.delta)) await a.page.mouse.wheel({ deltaY: Math.max(-900, Math.min(900, data.delta)) })
        else if (data.kind === 'key' && typeof data.key === 'string' && /^(?:(?:Control|Meta|Shift|Alt)\+){0,3}(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(data.key)) await this.press(a.page, data.key)
        else throw Error('Invalid browser input.')
        return this.state(a)
      }
      if (!['workspace_open', 'workspace_run', 'workspace_resume'].includes(action)) throw Error('Unknown device action.')
      if (['running', 'queued'].includes(a.status)) throw Error('An agent is already working or queued in this browser.')
      if (action === 'workspace_run') {
        if (typeof data.task !== 'string' || !data.task.trim() || data.task.length > 6000) throw Error('Enter a task.')
        a.task = data.task; a.history = []
      }
      if (action === 'workspace_resume' && typeof data.reply === 'string' && data.reply.trim()) a.task += '\nUser clarification: ' + data.reply.slice(0, 2000)
      if (action !== 'workspace_open' && !a.task) throw Error('Enter a task before continuing.')
      try { await this.open(a, data.url) }
      catch (error) {
        if (action !== 'workspace_open' && /429 Browser/.test(String(error))) {
          a.queued = { url: data.url }; a.status = 'queued'; a.detail = 'Waiting for a browser slot on this computer. Close another agent browser to free a slot.'
          return this.state(a)
        }
        throw error
      }
      if (action !== 'workspace_open') this.begin(a)
      return this.state(a)
    })
  }
  begin(a) {
    a.result = ''; a.detail = ''; a.status = 'running'; a.controller = new AbortController()
    delete a.queued
    const epoch = ++a.epoch
    setTimeout(() => void this.run(a, epoch), 0)
  }
  async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      for (const a of this.agents.values()) {
        if (a.status !== 'queued' || a.revoked) continue
        const limits = await this.host.limits()
        if (limits.activeSessions >= limits.maxConcurrentSessions) break
        await this.serial(a, async () => {
          if (a.status !== 'queued' || a.revoked) return
          try { await this.open(a, a.queued?.url); this.begin(a) }
          catch (error) { if (!/429 Browser/.test(String(error))) { a.status = 'needs_help'; a.detail = 'Could not start the queued browser. Review and Continue.' } }
        })
      }
    } finally { this.pumping = false }
  }
  async press(page, chord) {
    const keys = chord.split('+'), key = keys.pop()
    try { for (const modifier of keys) await page.keyboard.down(modifier); await page.keyboard.press(key) }
    finally { for (const modifier of keys.reverse()) await page.keyboard.up(modifier) }
  }
  async observe(a) {
    const page = a.page, handles = [], elements = [], texts = []
    let needsLogin = false
    const initialUrl = page.url()
    try {
    // Frame-local handles allow actions inside cross-origin Office/Google frames.
    for (const frame of page.frames().slice(0, 20)) {
      const text = await frame.evaluate(() => document.body?.innerText?.slice(0, 6000) || '').catch(() => '')
      texts.push(text)
      for (const handle of (await frame.$$('a,button,input,textarea,select,[role=button],[role=textbox],[contenteditable=true]').catch(() => [])).slice(0, 300)) {
        const box = await handle.boundingBox().catch(() => null)
        if (!box || !box.width || !box.height || box.x < 0 || box.y < 0 || box.x + box.width / 2 >= 1440 || box.y + box.height / 2 >= 900) { await handle.dispose(); continue }
        const info = await handle.evaluate(e => ({
          secure: e.matches('input[type=password],[autocomplete=one-time-code],[autocomplete=current-password],[autocomplete=new-password]'),
          tag: e.tagName, text: (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.getAttribute('title') || '').slice(0, 160),
          value: e.matches('input[type=password],[autocomplete=one-time-code],[autocomplete=current-password],[autocomplete=new-password]') ? undefined : typeof e.value === 'string' ? e.value.slice(0, 1000) : undefined,
        })).catch(() => null)
        if (!info || info.secure) { needsLogin ||= !!info?.secure; await handle.dispose(); continue }
        if (handles.length >= 120) { await handle.dispose(); continue }
        elements.push({ ...info, ref: handles.length, x: box.x + box.width / 2, y: box.y + box.height / 2 }); handles.push(handle)
      }
    }
    const pages = await a.browser.pages()
    if(page.url()!==initialUrl)throw Error('Page changed while observing.')
    return { handles, needsLogin, input: { protocol: 'nalu-device-v1', platform: process.platform, goal: a.task, url: page.url(), title: await page.title(), text: texts.join('\n').slice(0, 12000), elements,
      viewport: { w: 1440, h: 900 }, history: a.history.slice(-15), tabs: await Promise.all(pages.map(async (p, index) => ({ index, title: await p.title(), url: p.url(), active: p === page }))),
      screenshot: needsLogin ? undefined : 'data:image/jpeg;base64,' + await page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' }) } }
    } catch(error) { await Promise.all(handles.map(handle=>handle.dispose().catch(()=>{}))); throw error }
  }
  async observeStable(a) {
    for(let attempt=0; ; attempt++){
      try {return await this.observe(a)} catch(error) {
        if(attempt>=3 || !/detached frame|execution context was destroyed|cannot find context|page changed while observing/i.test(String(error.message)))throw error
        // Only repeat page observation; never replay a click, submission or edit.
        await new Promise(resolve=>setTimeout(resolve,250))
      }
    }
  }
  async execute(a, action, observed) {
    const page = a.page, pages = await a.browser.pages()
    validateAction(action, observed.handles.length, pages.length)
    switch (action.type) {
      case 'ask': a.status = 'needs_help'; a.detail = action.question.slice(0, 4000); break
      case 'finish': a.status = 'done'; a.result = action.summary.slice(0, 20000); break
      case 'navigate': await page.goto(webUrl(action.url), { waitUntil: 'domcontentloaded', timeout: 25000 }); break
      case 'newtab': if (pages.length >= 12) throw Error('Close a tab before opening another.'); a.page = await a.browser.newPage(); await a.page.goto(webUrl(action.url), { waitUntil: 'domcontentloaded', timeout: 25000 }); break
      case 'switchtab': a.page = pages[action.index]; break
      case 'closetab': if (pages.length < 2) throw Error('Keep one browser tab open.'); await page.close(); a.page = (await a.browser.pages()).at(-1); break
      case 'click': { const box = await observed.handles[action.ref].boundingBox(); if (box) a.cursor = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; await observed.handles[action.ref].click(); break }
      case 'type': {
        const handle = observed.handles[action.ref]
        await handle.evaluate(e => {
          if (e.matches('[readonly],:disabled,input[type=file],input[type=password]')) throw Error('This field requires human control.')
          e.focus()
          if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) e.select()
          else if (e.isContentEditable) { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r) }
          else throw Error('Target is not a text field.')
        })
        await page.keyboard.type(action.text)
        if (action.submit === true) await page.keyboard.press('Enter')
        break
      }
      case 'press': await this.press(page, action.key); break
      case 'type_text': await page.keyboard.type(action.text); break
      case 'drag':
        await page.mouse.move(action.x, action.y)
        try { await page.mouse.down(); await page.mouse.move(action.x2, action.y2, { steps: 12 }) }
        finally { await page.mouse.up() }
        a.cursor = { x: action.x2, y: action.y2 }; break
      case 'click_at': a.cursor = { x: action.x, y: action.y }; await page.mouse.click(action.x, action.y); break
      case 'scroll': await page.mouse.wheel({ deltaY: ({ up: -700, down: 700, top: -10000, bottom: 10000 })[action.direction] }); break
    }
  }
  async run(a, epoch) {
    let observed
    try {
      for (let step = 0; step < 40 && a.epoch === epoch && a.status === 'running'; step++) {
        observed = await this.serial(a, () => this.observeStable(a))
        if (a.epoch !== epoch) break
        if (observed.needsLogin) { a.status = 'needs_help'; a.detail = 'Sign in directly in the browser, then choose Continue. Do not put passwords or codes in chat.'; break }
        const decision = await this.decide(a.owner, observed.input, a.controller.signal)
        await this.serial(a, async () => {
          if (a.epoch !== epoch || a.status !== 'running') return
          if (a.page.url() !== observed.input.url) throw Error('The page changed during inference.')
          if (a.history.slice(-3).length === 3 && a.history.slice(-3).every(h => JSON.stringify(h.action) === JSON.stringify(decision.action)) && !['scroll', 'finish', 'ask'].includes(decision.action?.type)) throw Error('The agent repeated the same action without confirmed progress.')
          await this.execute(a, decision.action, observed)
          a.history.push({ action: decision.action, result: String(decision.thought || decision.action.type).slice(0, 1000) })
        })
        await Promise.all(observed.handles.map(h => h.dispose().catch(() => {}))); observed = null
      }
      if (a.epoch === epoch && a.status === 'running') { a.status = 'needs_help'; a.detail = 'Review the progress, then Continue to allow more steps.' }
    } catch (e) {
      if (a.epoch === epoch) { a.status = 'needs_help'; a.detail = 'The last action could not be confirmed. Review the page before continuing. ' + String(e.message).slice(0, 200) }
    } finally { if (observed) await Promise.all(observed.handles.map(h => h.dispose().catch(() => {}))) }
  }
  async disconnect() {
    const all = [...this.agents.values()]
    for (const a of all) { a.revoked = true; a.epoch++; a.controller?.abort(); a.status = 'paused' }
    await Promise.all(all.map(a => this.serial(a, async () => { if (a.browser) await a.browser.close().catch(() => {}); a.browser = null; a.page = null })))
    this.agents.clear()
  }
}
