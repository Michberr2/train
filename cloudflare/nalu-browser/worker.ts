import puppeteer from '@cloudflare/puppeteer'
import { httpUrl, parseAction, SYSTEM } from './policy'

type Env = { BROWSER: any; AI: any; WORKSPACES: any; SERVICE_KEY: string }
type Task = { errorStage?: string; id: string; sessionId: string; task: string; status: string; metadata: any; steps: { nextGoal: string }[]; output?: string; isSuccess?: boolean; inflight?: boolean; started: number }
type State = { liveUrl?: string; profileId?: string; sessionId?: string; closed?: boolean; creating?: boolean; task?: Task; cookies?: any[]; origins?: Record<string, Record<string, string>> }
const json = (data: any, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
const active = (task?: Task) => task && ['created', 'started'].includes(task.status)

export default {
  async fetch(req: Request, env: Env) {
    // This service is server-to-server only. Never expose its service key or
    // let a browser caller choose the account. Vercel resolves the account.
    if (!env.SERVICE_KEY || req.headers.get('Authorization') !== `Bearer ${env.SERVICE_KEY}`) return json({ error: 'Unauthorized' }, 401)
    const owner = req.headers.get('X-Nalu-Owner') || ''
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(owner)) return json({ error: 'Missing owner' }, 400)
    if (Number(req.headers.get('Content-Length') || 0) > 32000) return json({ error: 'Request too large' }, 413)
    if (new URL(req.url).pathname === '/limits' && req.method === 'GET') return json(await puppeteer.limits(env.BROWSER))
    const key = env.WORKSPACES.idFromName(owner)
    return env.WORKSPACES.get(key).fetch(req)
  },
}

export class BrowserWorkspace {
  private state: State = {}
  private busy = false
  private ready: Promise<void>
  constructor(private ctx: any, private env: Env) {
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get('workspace') || {}
      const count = await ctx.storage.get('profile-count') || 0
      if (count) {
        const parts = await Promise.all(Array.from({ length: count }, (_, i) => ctx.storage.get(`profile-${i}`)))
        Object.assign(this.state, JSON.parse(parts.join('')))
      }
    })
  }
  private save() { const { cookies, origins, ...metadata } = this.state; return this.ctx.storage.put('workspace', metadata) }
  private async connect() {
    if (!this.state.sessionId || this.state.closed) throw Error('Browser closed')
    return puppeteer.connect(this.env.BROWSER, this.state.sessionId)
  }
  private async capture(browser: any) {
    const cookieSession = await browser.target().createCDPSession()
    try { this.state.cookies = (await cookieSession.send('Storage.getCookies')).cookies } finally { await cookieSession.detach() }
    this.state.origins ||= {}
    for (const page of (await browser.pages()).slice(0, 12)) {
      if (!httpUrl(page.url())) continue
      const origin = new URL(page.url()).origin
      const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))).catch(() => null)
      if (storage && JSON.stringify(storage).length < 150000) this.state.origins[origin] = storage
    }
    // Keep the profile bounded; never include it in responses or model input.
    this.state.origins = Object.fromEntries(Object.entries(this.state.origins).slice(-40))
    const profile = JSON.stringify({ cookies: this.state.cookies, origins: this.state.origins })
    if (profile.length > 1000000) throw Error('Browser profile size limit')
    const parts: Record<string, string | number> = { 'profile-count': Math.ceil(profile.length / 16000) }
    for (let i = 0; i < Number(parts['profile-count']); i++) parts[`profile-${i}`] = profile.slice(i * 16000, (i + 1) * 16000)
    await this.ctx.storage.put(parts)
    await this.save()
  }
  private async session() {
    if (!this.state.sessionId) throw Error('Missing session')
    if (this.busy) return { id: this.state.sessionId, status: this.state.closed ? 'stopped' : 'active', liveUrl: this.state.liveUrl, tasks: this.state.task ? [this.state.task] : [] }
    let browser: any
    this.busy = true
    try {
      browser = await this.connect()
      await this.capture(browser)
      const page = (await browser.pages()).at(-1) || await browser.newPage()
      const cdp = await page.target().createCDPSession()
      try {
        const live = await cdp.send('Cloudflare.getLiveView', { mode: 'full', expiresInMs: 300000 })
        this.state.liveUrl = live.devtoolsFrontendUrl; await this.save()
        return { id: this.state.sessionId, status: 'active', liveUrl: live.devtoolsFrontendUrl, tasks: this.state.task ? [this.state.task] : [] }
      } finally { await cdp.detach() }
    } finally { if (browser) await browser.disconnect(); this.busy = false }
  }
  async fetch(req: Request) {
    await this.ready
    const path = new URL(req.url).pathname
    let body: any = {}
    if (req.method !== 'GET') {
      const text = await req.text()
      if (text.length > 32000) return json({ error: 'Request too large' }, 413)
      try { body = JSON.parse(text || '{}') } catch { return json({ error: 'Invalid JSON' }, 400) }
    }
    let stage = 'request'
    try {
      if (path === '/profiles' && req.method === 'POST') {
        this.state.profileId ||= crypto.randomUUID(); await this.save()
        return json({ id: this.state.profileId })
      }
      if (path === '/sessions' && req.method === 'POST') {
        if (body.profileId !== this.state.profileId || !this.state.profileId) return json({ error: 'Unknown profile' }, 404)
        if (this.busy || this.state.creating) return json({ error: 'Browser creation in progress' }, 409)
        if (body.startUrl && !httpUrl(body.startUrl)) return json({ error: 'Invalid URL' }, 400)
        if (this.state.sessionId && !this.state.closed) {
          try { return json(await this.session()) } catch { /* Expired session: restore this owner's saved profile. */ }
        }
        this.busy = true; this.state.creating = true; await this.save()
        let browser: any
        try {
          stage = 'acquire'
          const acquired = await puppeteer.acquire(this.env.BROWSER, { keep_alive: 600000 })
          this.state.sessionId = acquired.sessionId; await this.save()
          stage = 'connect'
          browser = await puppeteer.connect(this.env.BROWSER, acquired.sessionId)
          this.state.sessionId = browser.sessionId(); this.state.closed = false; delete this.state.creating
          delete this.state.task; await this.save()
          stage = 'restore'
          if (this.state.cookies?.length) {
            const cookieSession = await browser.target().createCDPSession()
            try { await cookieSession.send('Storage.setCookies', { cookies: this.state.cookies }) } finally { await cookieSession.detach() }
          }
          const page = (await browser.pages())[0] || await browser.newPage()
          await page.setViewport({ width: 1440, height: 900 })
          const origins = this.state.origins || {}
          await page.evaluateOnNewDocument((stored: any) => {
            const values = stored[location.origin]
            if (values) for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value))
          }, origins)
          if (body.startUrl) await page.goto(httpUrl(body.startUrl), { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
          stage = 'live-view'
          const liveSession = await page.target().createCDPSession()
          try { this.state.liveUrl = (await liveSession.send('Cloudflare.getLiveView', { mode: 'full', expiresInMs: 300000 })).devtoolsFrontendUrl; await this.save() } finally { await liveSession.detach() }
        } finally { if (browser) await browser.disconnect(); this.busy = false }
        return json({ id: this.state.sessionId, status: 'active', liveUrl: this.state.liveUrl, tasks: [] })
      }
      const sessionMatch = path.match(/^\/sessions\/([a-zA-Z0-9-]+)$/)
      if (sessionMatch) {
        if (sessionMatch[1] !== this.state.sessionId) return json({ error: 'Unknown session' }, 404)
        if (req.method === 'PATCH' && body.action === 'stop') {
          if (this.state.task && active(this.state.task)) { this.state.task.status = 'stopped'; await this.save() }
          if (this.busy) return json({ error: 'Waiting for current action to finish' }, 409)
          if (!this.state.closed) {
            const browser = await this.connect().catch(() => null)
            if (browser) { await this.capture(browser); await browser.close() }
            this.state.closed = true; await this.save()
          }
          return json({ id: this.state.sessionId, status: 'stopped' })
        }
        if (req.method !== 'GET') return json({ error: 'Unsupported action' }, 400)
        if (this.state.closed) return json({ id: this.state.sessionId, status: 'stopped', tasks: this.state.task ? [this.state.task] : [] })
        try { return json(await this.session()) } catch {
          // Do not silently report a task as done when a session expires.
          if (active(this.state.task) && !this.busy) { this.state.task!.status = 'failed'; this.state.task!.output = 'Browser connection ended. Open Browser and review the last step before continuing.'; await this.save() }
          return json({ id: this.state.sessionId, status: 'stopped', tasks: this.state.task ? [this.state.task] : [] })
        }
      }
      if (path === '/tasks' && req.method === 'POST') {
        if (body.sessionId !== this.state.sessionId || this.state.closed) return json({ error: 'Unknown session' }, 404)
        if (typeof body.task !== 'string' || !body.task.trim() || body.task.length > 6000 || !body.metadata?.naluTaskId) return json({ error: 'Invalid task' }, 400)
        if (this.state.task?.metadata.naluTaskId === body.metadata.naluTaskId) return json(this.state.task)
        if (active(this.state.task) || this.busy) return json({ error: 'Task in progress' }, 409)
        this.state.task = { id: crypto.randomUUID(), sessionId: this.state.sessionId!, task: body.task, status: 'created', metadata: { naluTaskId: body.metadata.naluTaskId }, steps: [], started: Date.now() }
        await this.save(); await this.ctx.storage.setAlarm(Date.now() + 5000)
        return json(this.state.task)
      }
      const taskMatch = path.match(/^\/tasks\/([a-zA-Z0-9-]+)$/)
      if (taskMatch && taskMatch[1] === this.state.task?.id) {
        if (req.method === 'PATCH' && body.action === 'stop') {
          this.state.task.status = 'stopped'; await this.save()
          if (this.busy) return json({ error: 'Waiting for current action to finish' }, 409)
        } else if (req.method !== 'GET') return json({ error: 'Unsupported action' }, 400)
        return json({ ...this.state.task, ...(this.busy && this.state.task.status === 'stopped' ? { status: 'started' } : {}) })
      }
      return json({ error: 'Not found' }, 404)
    } catch (error) {
      if (stage === 'acquire' && /429|rate limit/i.test(String(error))) {
        delete this.state.creating; await this.save()
        return json({ error: 'Browser capacity is temporarily unavailable', stage }, 429)
      }
      // Never return browser URLs with signed tokens, cookies, or provider errors.
      return json({ error: 'Browser operation could not be confirmed', stage, failure: /limit|quota|429/i.test(String(error)) ? 'capacity' : error instanceof TypeError ? 'api-compatibility' : 'provider' }, 503)
    }
  }
  async alarm() {
    await this.ready
    const task = this.state.task
    if (!active(task)) return
    if (this.busy) { await this.ctx.storage.setAlarm(Date.now() + 1500); return }
    if (task!.inflight) {
      task!.status = 'failed'; task!.output = 'The previous browser action was interrupted. Review the page before continuing; it has not been repeated.'; await this.save(); return
    }
    if (task!.steps.length >= 40 || Date.now() - task!.started > 15 * 60 * 1000) {
      task!.status = 'failed'; task!.output = 'The browser task reached its limit. Review the page and provide a follow-up.'; await this.save(); return
    }
    this.busy = true
    let browser: any, stage = 'connect'
    try {
      task!.status = 'started'; task!.inflight = true; await this.save()
      browser = await this.connect()
      const page = (await browser.pages()).at(-1) || await browser.newPage()
      await page.setViewport({ width: 1440, height: 900 })
      // Element handles are fixed for this observation; no model-provided
      // selector is evaluated. Password fields and hidden inputs are excluded.
      stage = 'observe'
      const handles = await page.$$('a,button,input:not([type=hidden]):not([type=password]),textarea,select,[role=button],[role=textbox],[contenteditable=true]')
      const visible: { handle: any; label: string; tag: string }[] = []
      for (const handle of handles.slice(0, 400)) {
        const info = await handle.evaluate((e: any) => {
          const r = e.getBoundingClientRect(), style = getComputedStyle(e)
          if (!r.width || !r.height || style.visibility === 'hidden' || r.bottom < 0 || r.top > innerHeight) return null
          return { label: (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.getAttribute('title') || '').slice(0, 160), tag: e.tagName }
        }).catch(() => null)
        if (info) visible.push({ handle, ...info })
        if (visible.length >= 200) break
      }
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 14000) || '')
      const input = `TASK: ${task!.task}\nURL: ${page.url()}\nTITLE: ${await page.title()}\nPRIOR ACTIONS: ${JSON.stringify(task!.steps.slice(-12))}\nPAGE TEXT: ${text}\nELEMENTS: ${JSON.stringify(visible.map((v, index) => ({ index, tag: v.tag, text: v.label })))}`
      stage = 'model'
      const result = await this.env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: input }], max_tokens: 1500, temperature: 0.1 })
      stage = 'model-format'
      const action = parseAction(result.response || '')
      stage = 'action'
      // A takeover may arrive while inference is running. Stop before input.
      if (!active(task)) return
      if (action.action === 'done' || action.action === 'blocked') {
        task!.status = 'finished'; task!.isSuccess = action.action === 'done'; task!.output = action.reason
      } else if (action.action === 'navigate') {
        await page.goto(httpUrl(action.url), { waitUntil: 'domcontentloaded', timeout: 25000 })
      } else if (action.action === 'click' || action.action === 'type') {
        const element = visible[action.index]?.handle
        if (!element) throw Error('Missing element')
        if (action.action === 'click') await element.click()
        else {
          const safe = await element.evaluate((e: any) => e.type !== 'password' && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable))
          if (!safe) throw Error('Not an editable element')
          await element.focus(); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.type(action.text)
        }
      } else if (action.action === 'press') {
        const keys = action.key.split('+'); const key = keys.pop()
        try { for (const modifier of keys) await page.keyboard.down(modifier); await page.keyboard.press(key) }
        finally { for (const modifier of keys.reverse()) await page.keyboard.up(modifier) }
      } else if (action.action === 'scroll') await page.mouse.wheel({ deltaY: action.direction === 'up' ? -650 : 650 })
      task!.steps.push({ nextGoal: action.reason.slice(0, 1000) }); stage = 'save-profile'; await this.capture(browser)
    } catch {
      if (active(task)) { task!.errorStage = stage; task!.status = 'failed'; task!.output = 'The last browser step could not be confirmed. Review the page in Browser before continuing.' }
    } finally {
      if (browser) await Promise.resolve(browser.disconnect()).catch(() => {})
      if (task) { delete task.inflight; await this.save() }
      this.busy = false
      if (active(task)) await this.ctx.storage.setAlarm(Date.now() + 1500)
    }
  }
}
