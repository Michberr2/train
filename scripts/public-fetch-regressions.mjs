// Exercise the real outbound transport with fake DNS and sockets: no network.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
let dns, respond, lookups, requests
function reset() { lookups = []; requests = []; dns = () => [{address:'93.184.216.34',family:4}]; respond = () => ({body:'public result'}) }
reset()
function fakeRequest(url, options, callback) {
  const req = new EventEmitter()
  req.end = body => {
    const record = {url:url.href,headers:options.headers,method:options.method,body}
    requests.push(record)
    options.lookup(url.hostname, {all:true}, (error, addresses) => {
      assert.ifError(error); record.pinned = addresses
    })
    let incoming
    const abort = () => { incoming?.destroy(); req.emit('error', options.signal.reason) }
    options.signal.addEventListener('abort', abort, {once:true})
    setImmediate(async () => {
      if (options.signal.aborted) return
      try {
        const spec = await respond(record)
        if (!spec || options.signal.aborted) return
        incoming = new PassThrough()
        Object.assign(incoming, {statusCode:spec.status || 200,statusMessage:'',headers:spec.headers || {'content-type':'text/plain'}})
        incoming.once('close', () => options.signal.removeEventListener('abort', abort))
        callback(incoming)
        if (!incoming.destroyed && !spec.hangBody) incoming.end(spec.body || '')
      } catch (error) { req.emit('error', error) }
    })
  }
  return req
}
const built = await build({entryPoints:['api/_publicFetch.ts'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'})
const module = {exports:{}}
new Function('require','module','exports',built.outputFiles[0].text)(id => {
  if (id === 'node:dns/promises') return {lookup:async host => { lookups.push(host); return dns(host) }}
  if (id === 'node:http' || id === 'node:https') return {...require(id),request:fakeRequest}
  return require(id)
},module,module.exports)
const {publicFetch,publicHttpUrl} = module.exports

for (const url of ['http://localhost/x','http://127.0.0.1','http://2130706433','http://0x7f000001','http://10.2.3.4','http://169.254.169.254/latest','http://100.64.0.1','http://[::1]','http://[::ffff:127.0.0.1]','http://[fe80::1]','http://[2002:7f00:1::]','http://host.local','http://host.home.arpa','https://u:p@example.com','file:///etc/passwd']) {
  assert.throws(() => publicHttpUrl(url), /public/)
  await assert.rejects(publicFetch(url), /public/)
}
assert.equal(requests.length,0)
for (const addresses of [[{address:'10.0.0.4',family:4}], [{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}], [{address:'::ffff:10.0.0.4',family:6}]]) {
  dns = () => addresses
  await assert.rejects(publicFetch('https://mixed.example.com'), /public internet/)
}
assert.equal(requests.length,0)
reset()
assert.equal(await (await publicFetch('https://public.example.com/path',{headers:{Host:'private.internal'}})).text(),'public result')
assert.deepEqual(lookups,['public.example.com'])
assert.deepEqual(requests[0].pinned,[{address:'93.184.216.34',family:4}])
assert.equal(requests[0].headers.host,undefined)

reset()
const binary = Buffer.from([0, 255, 128, 65, 0, 240, 159, 140, 138])
respond = () => ({headers:{'content-type':'application/octet-stream'},body:binary})
assert.deepEqual(new Uint8Array(await (await publicFetch('https://public.example.com/bytes')).arrayBuffer()), new Uint8Array(binary), 'Response body copy preserves every binary byte')

reset()
respond = ({url}) => url.includes('/start') ? {status:302,headers:{location:'https://next.example.com/end'}} : {body:'redirected'}
const redirected = await publicFetch('https://public.example.com/start',{headers:{Authorization:'secret',Cookie:'session', 'X-Custom-Token':'private',Accept:'text/html'}})
assert.equal(redirected.url,'https://next.example.com/end')
assert.equal(await redirected.text(),'redirected')
assert.deepEqual(lookups,['public.example.com','next.example.com'])
assert.equal(requests[1].headers.authorization,undefined)
assert.equal(requests[1].headers.cookie,undefined)
assert.equal(requests[1].headers['x-custom-token'],undefined)
assert.equal(requests[1].headers.accept,'text/html')

for (const destination of ['http://127.0.0.1/private','https://private.example.com']) {
  reset()
  dns = host => [{address:host === 'private.example.com' ? '192.168.1.2' : '93.184.216.34',family:4}]
  respond = () => ({status:302,headers:{location:destination}})
  await assert.rejects(publicFetch('https://public.example.com/start'),/public/)
  assert.equal(requests.length,1,'redirect must be rejected before opening its socket')
}
reset()
respond = () => ({status:307,headers:{location:'https://next.example.com/submit'}})
await assert.rejects(publicFetch('https://public.example.com/submit',{method:'POST',body:'a=1'}),/Redirects are not allowed/)
assert.equal(requests.length,1,'mutations must never be replayed')
reset()
respond = () => ({status:302,headers:{location:'/loop'}})
await assert.rejects(publicFetch('https://public.example.com/loop',{maxRedirects:2}),/too many/)
assert.equal(requests.length,3)
respond = () => ({status:302,headers:{location:'http://public.example.com/insecure'}})
await assert.rejects(publicFetch('https://public.example.com/start'),/insecure/)

reset()
respond = () => ({headers:{'content-encoding':'gzip'},body:gzipSync('bounded text')})
const gzip = await publicFetch('https://public.example.com')
assert.equal(await gzip.text(),'bounded text'); assert.equal(gzip.headers.get('content-encoding'),null)
respond = () => ({body:'x'.repeat(1025)})
await assert.rejects(publicFetch('https://public.example.com',{maxBytes:1024}),/reading limit/)
respond = () => ({headers:{'content-encoding':'gzip'},body:gzipSync('x'.repeat(100000))})
await assert.rejects(publicFetch('https://public.example.com',{maxBytes:1024}),/reading limit/)
for (const status of [204,205,304]) {
  respond = () => ({status})
  assert.equal((await publicFetch('https://public.example.com')).status,status)
}
for (const status of [100,600,999]) {
  respond = () => ({status,body:'invalid final status'})
  await assert.rejects(publicFetch('https://public.example.com'),/unsupported HTTP status/)
}
for (const stage of ['dns','headers','body']) {
  reset()
  if (stage === 'dns') dns = () => new Promise(() => {})
  if (stage === 'headers') respond = () => null
  if (stage === 'body') respond = () => ({hangBody:true})
  const started = Date.now()
  await assert.rejects(publicFetch('https://public.example.com',{timeoutMs:25}),/timed out/)
  assert.ok(Date.now()-started<500,`${stage} must share the request deadline`)
}
reset()
respond = () => null
const controller = new AbortController()
const pending = publicFetch('https://public.example.com',{signal:controller.signal})
setTimeout(() => controller.abort(),10)
await assert.rejects(pending,/abort/i)
console.log('PASS public URL/DNS validation, pinned sockets, redirect destinations/credentials, single-send mutations, decoded size limits, DNS/header/body deadlines and cancellation.')
