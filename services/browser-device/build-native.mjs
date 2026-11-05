import { build } from '../browser-host/node_modules/esbuild/lib/main.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(process.argv[2] || path.join(root, 'dist'))
await mkdir(out, { recursive: true })
await build({ entryPoints: [path.join(root, 'server.mjs')], outfile: path.join(out, 'browser-device.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  plugins: [{ name: 'native-browser', setup(b) { b.onResolve({ filter: /browser-host\/adapter\.mjs$/ }, () => ({ path: path.join(root, 'native-host.mjs') })) } }],
  nodePaths: [path.join(root, '../browser-host/node_modules')], legalComments: 'eof', logLevel: 'warning',
})
await writeFile(path.join(out, 'README.txt'), 'Nalu local browser companion. Browser profiles stay on this computer. AI observations are sent to the signed-in Nalu service. Source: services/browser-device in Michberr2/train.\n')
console.log('Built native browser companion: ' + out)
