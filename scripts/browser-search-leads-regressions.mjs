import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {transform} from 'esbuild'
const source=await readFile('api/web.ts','utf8')
const extracted=source.slice(source.indexOf('type AgentEl ='),source.indexOf('// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport default async function handler'))
const compiled=await transform(`const search=globalThis.searchFixture;const browserDecision=globalThis.decisionFixture;${extracted}\nexport {agentStep}`,{loader:'ts',format:'esm'})
let searches=[],prompt=''
globalThis.searchFixture=async query=>{searches.push(query);return {text:'NASA Artemis\nhttps://www.nasa.gov/artemis/'}}
globalThis.decisionFixture=async(_system,user)=>{prompt=user;return JSON.stringify({action:{type:'navigate',url:'https://www.nasa.gov/artemis/'}})}
const {agentStep}=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'))
const base={protocol:'nalu-device-v1',goal:'Search the web for NASA Artemis. Open the official page.',history:[]}
await agentStep(base);assert.deepEqual(searches,['NASA Artemis']);assert.match(prompt,/untrusted excerpts, not pages read/);assert.match(prompt,/Open a relevant source in the browser and verify/)
for(const input of [{...base,history:[{action:{type:'navigate'},result:'Opened'}]},{...base,goal:'Search for my private email in Gmail'},{...base,goal:'Update my document'},{...base,protocol:undefined}])await agentStep(input)
assert.equal(searches.length,1)
delete globalThis.searchFixture;delete globalThis.decisionFixture
console.log('PASS first-turn public search leads, verified-page instruction, no repeated lookups or private inbox/document searches')
