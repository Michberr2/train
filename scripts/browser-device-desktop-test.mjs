import { build } from 'esbuild'
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
const desktop = path.resolve('../naludesktop')
const dir = await mkdtemp(path.join(os.tmpdir(), 'nalu-device-electron-'))
await mkdir(path.join(dir, 'build/browser-device'), { recursive: true })
await copyFile(path.join(desktop, 'build/browser-device/browser-device.cjs'), path.join(dir, 'build/browser-device/browser-device.cjs'))
await build({ entryPoints: [path.join(desktop, 'electron/browserDevice.ts')], outfile: path.join(dir, 'controller.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
await writeFile(path.join(dir, 'test.cjs'), `
const { app } = require('electron'), assert = require('node:assert/strict'), path = require('node:path');
const { BrowserDevice } = require('./controller.cjs');
app.setAppPath(__dirname); app.setPath('userData', path.join(__dirname, 'profile'));
app.whenReady().then(async()=>{
 const device = new BrowserDevice();
 try {
  const code = await device.start(); assert.match(code,/^[a-f0-9]{24}$/);
  const again = await device.start(); assert.equal(again,code);
  const response = await fetch('http://127.0.0.1:8877/device',{method:'POST',headers:{Origin:'https://n4lu.com','Content-Type':'application/json'},body:JSON.stringify({action:'pair',code:'wrong'})});
  assert.equal(response.status,403);
  const foreign = await fetch('http://127.0.0.1:8877/device',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({action:'pair',code})});
  assert.equal(foreign.status,403);
  device.stop();
  let closed = false;
  for(let i=0;i<60;i++){ try{await fetch('http://127.0.0.1:8877/device',{signal:AbortSignal.timeout(100)})}catch{closed=true;break} await new Promise(r=>setTimeout(r,100)); }
  assert.ok(closed,'companion stops with desktop lifecycle');
  console.log('PASS Electron utility-process startup, bundled companion, private code, origin rejection, and shutdown.'); app.exit(0);
 }catch(e){device.stop();console.error(e);app.exit(1)}
});`)
const child = spawn(path.join(desktop, 'node_modules/.bin/electron'), [path.join(dir, 'test.cjs')], { stdio: 'inherit', env: { ...process.env, NALU_DISABLE_UPDATES: '1' } })
const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)) })
process.exitCode = status || 0
