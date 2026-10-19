// Exercise the canonical CLI's capture functions with an in-memory filesystem.
// No session content, credential values or training data leave this process.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {parse} from 'acorn'
const canonical = new URL('../../naludesktop/cli/nalu.mjs',import.meta.url)
const source=fs.readFileSync(canonical,'utf8')
const names=['turnsFromWire','redactTrainingText','recordTrainingRow','announcesIntent']
const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'})
const functions=names.map(name=>{
  const declaration=ast.body.find(node=>node.type==='FunctionDeclaration'&&node.id?.name===name)
  assert.ok(declaration,`canonical CLI function ${name} exists`)
  return source.slice(declaration.start,declaration.end)
}).join('\n')
let writes=[],modes=[],opened=0,closed=0
const fakeFs={mkdirSync(_path,options){modes.push(options.mode)},chmodSync(_path,mode){modes.push(mode)},openSync(_path,flag,mode){assert.equal(flag,'a');modes.push(mode);opened++;return 4},fchmodSync(fd,mode){assert.equal(fd,4);modes.push(mode)},writeSync(fd,text){assert.equal(fd,4);writes.push(text)},closeSync(){closed++}}
const environment={}
const {capture}=new Function('fs','os','path','process','randomUUID','createHash','VERSION',functions+'\nreturn {capture:recordTrainingRow}')(fakeFs,{homedir:()=>'/fixture'},path,{env:environment},randomUUID,createHash,'test')
const state={messages:[{role:'user',content:'Explain this code.'},{role:'assistant',content:'The function adds two finite numbers.'}],lastRoute:'coding'}
capture(state,0);assert.equal(writes.length,0,'capture is off by default')
environment.NALU_TRAINING_DATA='1'
for(const disable of ['1','true','yes']){environment.NALU_NO_TRAINING_DATA=disable;capture(state,0);assert.equal(writes.length,0)}
delete environment.NALU_NO_TRAINING_DATA
environment.TINKER_API_KEY='fixture-secret-value-123'
capture({...state,messages:[{role:'user',content:'Use fixture-secret-value-123 and Bearer abcdefghijklmnopqrstuvwxyz123456789'},state.messages[1]]},0)
assert.equal(writes.length,1);assert.equal(opened,closed);assert.deepEqual(modes,[0o700,0o700,0o600,0o600])
assert.doesNotMatch(writes[0],/fixture-secret-value|abcdefghijklmnopqrstuvwxyz/)
const row=JSON.parse(writes[0])
assert.equal(row.training.consent.capture,true);assert.equal(row.training.consent.remoteTraining,false)
assert.equal(row.training.review.quality,'pending');assert.equal(row.training.review.redaction,'automated-only')
assert.equal(row.training.contentSha256,createHash('sha256').update(JSON.stringify({system:'',turns:row.turns})).digest('hex'))
assert.equal(row.repo,undefined,'repository identity is not captured unnecessarily')
capture({...state,messages:[state.messages[0],{role:'assistant',content:'(error: provider unavailable)'}]},0)
assert.equal(writes.length,1,'failed outputs do not become training rows')
console.log('PASS canonical CLI defaults/legacy opt-out, redaction, private file modes, capture-vs-upload consent, pending review and source hash.')
