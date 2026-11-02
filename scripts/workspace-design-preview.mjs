// Dedicated, loopback-only design review. Never proxy these APIs to production.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../client', import.meta.url))
// Tailwind's existing relative content globs are resolved from cwd. Match the
// normal `npm --workspace client run dev` environment so all real UI utilities
// are included by this dedicated server too.
process.chdir(root)
const port = Number(process.env.WORKSPACE_PREVIEW_PORT || 5193)
const token = 'local-only-workspace-design-preview-v1'
const memory = new Map()
const attachments = new Map()
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const message = 'Sample preview response: the launch website, brief, and budget are ready for review. Confirm the headline, assign the launch owner, and share the first release with a small customer group. This response is local sample data; no model or account was contacted.'

const server = await createServer({
  configFile: false, root, envDir: root,
  cacheDir: `/private/tmp/nalu-adaptive-workspace-vite-cache-${port}`,
  plugins: [react(), {
    name: 'isolated-workspace-design-preview',
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
        const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value)) }
        if (path === '/__workspace-design-preview') return json({ preview: 'functional-workspace-v1', localOnly: true })
        if (path === '/') { res.statusCode = 302; res.setHeader('Location', '/workspace-preview?shell=production'); return res.end() }
        if (!path.startsWith('/api/')) return next()
        try {
          let raw = ''
          for await (const chunk of req) {
            raw += chunk.toString()
            if (raw.length > 16 * 1024 * 1024) return json({ error: 'Preview request too large.' }, 413)
          }
          const body = raw ? JSON.parse(raw) : {}
          const credential = req.headers.authorization?.replace(/^Bearer /, '') || body.token
          if (credential && credential !== token) return json({ error: 'Only the local preview identity is accepted.' }, 403)
          if (path === '/api/community' && body.action === 'list') return json({ rooms: [] })
          if (path === '/api/swarm' && body.action === 'list') return json({ state: { version: 1, mode: 'live', projects: [], tasks: [], messages: [], turns: [] }, revision: 1 })
          if (path === '/api/data') {
            if (body.action === 'task-feed') return json({ ok: true, tasks: [] })
            // Browser storage is the durable preview store. An unrelated preview
            // browser/tab must never replace it with this server's sample cache.
            if (body.action === 'load') return json({ ok: true, data: {} })
            if (body.action === 'setMany') { for (const [key, value] of Object.entries(body.entries || {})) memory.set(key, value); return json({ ok: true }) }
            if (body.action === 'set') { memory.set(body.key, body.value); return json({ ok: true }) }
            return json({ ok: true, data: {}, items: [], tasks: [] })
          }
          if (path === '/api/auth' && body.action === 'me') return json({ ok: true, user: { id: 'nalu-workspace-design-preview', displayName: 'Michael' } })
          if (path === '/api/billing' && req.method === 'GET') return json({ currency: 'usd', paymentPurpose: 'support', supportedAmountCents: 0, mode: 'unconfigured', checkoutEnabled: false, tipEligible: false, packs: [], transactions: [] })
          if (path === '/api/chat') {
            res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-store')
            for (const text of message.match(/.{1,48}(?:\s|$)/g) || [message]) {
              if (res.destroyed) return
              res.write(frame('delta', { text }))
              await new Promise(resolve => setTimeout(resolve, 120))
            }
            res.write(frame('finish', { reason: 'stop' })); return res.end(frame('done', { ok: true }))
          }
          // The real output writer still saves/downloads its actual Blob. These
          // acknowledgments are only its isolated, in-memory account transport.
          if (path === '/api/task-attachments') {
            if (body.action === 'begin') {
              const attachment = { id: `preview-${body.meta?.sourceId}`, parts: Math.ceil(Number(body.meta?.size || 0) / 786432) }
              attachments.set(attachment.id, attachment)
              return json({ attachment })
            }
            if (['part', 'finish'].includes(body.action) && attachments.has(body.id)) return json({ ok: true, preview: true })
            return json({ error: 'Unknown local sample attachment.' }, 404)
          }
          if (path === '/api/artifacts' && req.method === 'GET') return json({ outputs: [] })
          if (path === '/api/connect' && ['list', 'reviews'].includes(body.action)) return json({ ok: true, connections: [], reviews: [] })
          if (path === '/api/oauth' && req.method === 'GET') return json({ configured: [], providers: [] })
          if (path === '/api/team' && body.action === 'list') return json({ ok: true, members: [], teams: [], items: [] })
          if (path === '/api/notebook' && ['load', 'list'].includes(body.action)) return json({ ok: true, notes: [], items: [] })
          if (path === '/api/web' && body.action === 'places') return json({ results: [{ name: 'Forsyth Park', address: 'Savannah, Georgia', lat: 32.0676, lng: -81.0963, rating: 4.8, url: 'https://www.google.com/maps/search/?api=1&query=Forsyth+Park+Savannah' }], preview: true })
          if (path === '/api/web' && body.action === 'mapai') return json({ answer: 'Local preview example: Forsyth Park in Savannah. The map, layers, drawing, and camera controls are real; this search response is sample data.', center: { lat: 32.0676, lng: -81.0963 }, zoom: 14, search: 'Forsyth Park, Savannah', layers: [], shapes: [], preview: true })
          if (path === '/api/web' && body.action === 'search') return json({ results: [{ title: 'Local preview sample', url: 'https://example.com', snippet: 'Sample research input for reviewing the workflow UI.' }], preview: true })
          if (path === '/api/health') return json({ ok: true, preview: true })
          return json({ ok: false, error: 'This action needs your connected account. This local design preview uses sample work and does not run generation, publishing, or account changes.' }, 501)
        } catch (error) { return json({ error: `Preview request failed: ${error.message}` }, 400) }
      })
    },
  }],
  server: { host: '127.0.0.1', port, strictPort: true },
})
await server.listen()
console.log(`Local Nalu workspace: http://127.0.0.1:${port}/workspace-preview`)
console.log('Actual workspace components; isolated sample account and APIs. No production proxy.')
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0) })
