import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

const root = resolve('.')
const output = resolve(process.env.OUTPUT_DIR || '/tmp/nalu-accessibility-release')
await mkdir(output, { recursive: true })
let server, base = process.argv[2]
if (!base) {
  // Tailwind resolves its configuration from cwd during CSS transforms. Match
  // the client build instead of serving a page without the utility styles.
  process.chdir(resolve(root, 'client'))
  server = await createServer({ configFile: resolve(root, 'client/vite.config.ts'), root: resolve(root, 'client'), cacheDir: `${output}/vite-cache`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
}
let failed = false
try {
  for (const [script, folder] of [['public-accessibility-audit.mjs', 'public'], ['workspace-accessibility-audit.mjs', 'workspace']]) {
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, ['scripts/' + script, base], { cwd: root, stdio: 'inherit', env: { ...process.env, OUTPUT_DIR: `${output}/${folder}` } })
      child.once('error', reject); child.once('exit', code => done(code))
    })
    if (code !== 0) failed = true
  }
} finally { await server?.close() }
process.exitCode = failed ? 1 : 0
