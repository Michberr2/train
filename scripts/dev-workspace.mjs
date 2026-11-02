// Live-reloading local UI, connected to the existing Nalu account/skill API.
// No preview accounts, sample outputs, or production publication.
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../client', import.meta.url))
process.chdir(root)
const port = Number(process.env.NALU_DEV_PORT || 5197)
const server = await createServer({
  root,
  plugins: [{ name: 'local-owner-entry', configureServer(vite) {
    vite.middlewares.use('/__nalu_local_entry', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'application/json')
      const origin = req.headers.origin
      if (req.method !== 'POST' || req.headers['x-nalu-local-entry'] !== '1' ||
          ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) ||
          origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) {
        res.statusCode = 403; return res.end(JSON.stringify({ error: 'Local browser entry only.' }))
      }
      if (!process.env.NALU_DEV_OWNER_PASSWORD) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'Restart the local server with its owner login configured.' })) }
      try {
        const response = await fetch('https://n4lu.ai/api/auth', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'signin', email: 'michberr2@gmail.com', password: process.env.NALU_DEV_OWNER_PASSWORD }),
          signal: AbortSignal.timeout(25000),
        })
        res.statusCode = response.status
        res.end(JSON.stringify(await response.json()))
      } catch { res.statusCode = 503; res.end(JSON.stringify({ error: 'Could not open the account. Try again.' })) }
    })
  } }],
  server: {
    host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': { target: 'https://n4lu.ai', changeOrigin: true, secure: true } },
  },
})
await server.listen()
console.log(`Nalu local workspace: http://127.0.0.1:${port}`)
console.log('Live local UI; sign in to use your existing Nalu account and skills.')
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0) })
