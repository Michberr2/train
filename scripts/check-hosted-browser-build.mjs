import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const hashes=JSON.parse(await readFile('services/browser-cloud/manifest.json','utf8'))
for(const [file,expected] of Object.entries(hashes))assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),expected,'Hosted browser source/bundle changed; run node services/browser-cloud/build.mjs: '+file)
console.log('PASS hosted browser bundle matches its reviewed runtime, policy, proxy and dependency sources')
