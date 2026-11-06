import puppeteer from '@cloudflare/puppeteer/lib/esm/puppeteer/puppeteer-core.js'
import crypto from 'node:crypto'
import chromiumPackage from '@sparticuz/chromium'
const chromium = chromiumPackage.default || chromiumPackage
import fs from 'node:fs/promises'
import path from 'node:path'

const sessions = new Map()
let pending = 0
const capacity = Math.max(1, Math.min(4, Number(process.env.BROWSER_MAX_SESSIONS) || 2))
export default {
  async acquire({ owner }) {
    if (sessions.size + pending >= capacity) throw Error('429 Browser capacity: close another browser or wait for its task to finish.')
    if (!process.env.BROWSER_DATA_DIR) throw Error('Browser storage is unavailable.')
    pending++
    let browser
    try {
      const profile = path.join(process.env.BROWSER_DATA_DIR, 'profiles', crypto.createHash('sha256').update(owner).digest('hex'))
      await fs.mkdir(profile, { recursive: true, mode: 0o700 })
      browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), headless: true, pipe: true, userDataDir: profile,
        env: Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
        args: [...chromium.args.filter(arg => !['--disable-web-security', '--allow-running-insecure-content', '--disable-site-isolation-trials'].includes(arg)), '--proxy-server=http://127.0.0.1:8878', '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-extensions', '--no-first-run'],
        defaultViewport: { width: 1440, height: 900 } })
      const cdp = await browser.target().createCDPSession()
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }); await cdp.detach()
      const guard = async page => {
        await page.setRequestInterception(true)
        page.on('request', request => {
          let allowed = false
          try { allowed = ['http:', 'https:', 'data:', 'blob:', 'about:'].includes(new URL(request.url()).protocol) } catch {}
          void (allowed ? request.continue() : request.abort()).catch(() => {})
        })
      }
      await Promise.all((await browser.pages()).map(guard))
      browser.on('targetcreated', async target => { if (target.type() === 'page') { const page = await target.page(); if (page) await guard(page).catch(() => {}) } })
      const sessionId = crypto.randomUUID()
      sessions.set(sessionId, { owner, browser })
      browser.on('disconnected', () => sessions.delete(sessionId))
      return { sessionId }
    } catch (error) { if (browser) await browser.close().catch(() => {}); throw error }
    finally { pending-- }
  },
  async connect({ owner }, sessionId) {
    const record = sessions.get(sessionId)
    if (!record || record.owner !== owner) throw Error('This agent browser is closed.')
    return record.browser
  },
  async limits() { return { maxConcurrentSessions: capacity, activeSessions: sessions.size + pending } },
}
