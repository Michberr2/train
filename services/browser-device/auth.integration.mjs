import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
const child = spawn(process.execPath, ['--import', new URL('./auth-fixture.mjs', import.meta.url).href, new URL('./server.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: '8879' }, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''; child.stderr.on('data', b => { stderr += b })
const code = await new Promise((resolve, reject) => {
  let output = ''; const timer = setTimeout(() => reject(Error('Companion did not start: ' + stderr)), 10000)
  child.stdout.on('data', b => { output += b; const match = output.match(/Connection code: ([a-f0-9]+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
  child.on('exit', () => { clearTimeout(timer); reject(Error('Companion exited: ' + stderr)) })
})
const request = (data, { origin = 'https://n4lu.com', token = 'fixture-owner-a', device = '', host = '127.0.0.1:8879' } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port: 8879, path: '/device', method: 'POST', headers: { Origin: origin, Host: host, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Nalu-Device': device } }, res => {
    let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }))
  }); req.on('error', reject); req.end(JSON.stringify(data))
})
try {
  assert.equal((await request({ action: 'pair', code }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await request({ action: 'pair', code }, { host: 'rebind.example:8879' })).status, 403)
  assert.equal((await request({ action: 'pair', code: 'wrong' })).status, 403)
  assert.equal((await request({ action: 'pair', code }, { token: 'invalid-token' })).status, 400)
  const paired = await request({ action: 'pair', code }); assert.equal(paired.status, 200)
  const device = paired.body.device
  assert.equal((await request({ action: 'workspace_status' }, { device })).status, 200)
  assert.equal((await request({ action: 'workspace_status' }, { device, token: 'fixture-owner-b' })).status, 403)
  const next = await request({ action: 'pair', code }, { token: 'fixture-owner-b' }); assert.equal(next.status, 200)
  assert.equal((await request({ action: 'workspace_status' }, { device })).status, 401)
  assert.equal((await request({ action: 'workspace_status' }, { device: next.body.device, token: 'fixture-owner-b' })).status, 200)
  console.log('PASS: HTTP origin, Host rebinding, pairing code, verified account binding, and capability revocation. Identity responses mocked at the remote boundary.')
} finally { child.kill('SIGTERM'); await once(child, 'exit') }
