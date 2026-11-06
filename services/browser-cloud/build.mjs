import {build} from '../browser-host/node_modules/esbuild/lib/main.js'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root=path.dirname(fileURLToPath(import.meta.url))
await build({entryPoints:[path.join(root,'server.mjs')],outfile:path.join(root,'runtime.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['@sparticuz/chromium'],nodePaths:[path.join(root,'../browser-host/node_modules')],plugins:[{name:'hosted-browser',setup(b){b.onResolve({filter:/browser-host\/adapter\.mjs$/},()=>({path:path.join(root,'host.mjs')}))}}],logLevel:'warning'})
console.log('Built hosted browser runtime')
const {readFile,writeFile}=await import('node:fs/promises')
const {createHash}=await import('node:crypto')
const files=['services/browser-cloud/server.mjs','services/browser-cloud/host.mjs','services/browser-device/runtime.mjs','services/browser-device/policy.mjs','services/browser-host/proxy.mjs','services/browser-host/package-lock.json','services/browser-cloud/runtime.cjs']
const repo=path.resolve(root,'../..'),hashes={}
for(const file of files)hashes[file]=createHash('sha256').update(await readFile(path.join(repo,file))).digest('hex')
await writeFile(path.join(root,'manifest.json'),JSON.stringify(hashes,null,2)+'\n')
