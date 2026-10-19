import test from 'node:test'
import assert from 'node:assert/strict'
import {loadTrainingEnv} from './training-env.mjs'
const files={'/fixture/training/.env.local':'TINKER_API_KEY="training-fixture"\nTRAINING_ONLY=1\n','/fixture/.env.local':'TINKER_API_KEY=""\nDEFAULT_SETTING=base\n'}
test('training-specific credential is loaded despite empty repository placeholder',()=>{const env={};loadTrainingEnv('/fixture/training',env,p=>files[p]);assert.equal(env.TINKER_API_KEY,'training-fixture');assert.equal(env.DEFAULT_SETTING,'base')})
test('explicit nonempty environment takes precedence; empty value can be filled',()=>{const env={TINKER_API_KEY:'explicit',TRAINING_ONLY:''};loadTrainingEnv('/fixture/training',env,p=>files[p]);assert.equal(env.TINKER_API_KEY,'explicit');assert.equal(env.TRAINING_ONLY,'1')})
test('proper dotenv parsing handles export and single quotes without exposing values',()=>{const env={};loadTrainingEnv('/fixture/training',env,()=>"export TINKER_API_KEY='test value # literal'\n");assert.equal(env.TINKER_API_KEY,'test value # literal')})
test('missing optional files are allowed but unreadable files fail visibly',()=>{
 const env={};loadTrainingEnv('/fixture/training',env,()=>{throw Object.assign(Error(),{code:'ENOENT'})});assert.deepEqual(env,{})
 assert.throws(()=>loadTrainingEnv('/fixture/training',{},()=>{throw Object.assign(Error('permission denied'),{code:'EACCES'})}),/permission denied/)
})

test('actual flywheel loader resolves training-specific configuration',async()=>{
 const fs=await import('node:fs'),vm=await import('node:vm'),path=await import('node:path')
 const source=fs.readFileSync(process.env.NALU_FLYWHEEL_TEST_ENTRY||new URL('./flywheel.mjs',import.meta.url),'utf8')
 const a=source.indexOf('function loadEnvLocal()'),b=source.indexOf('\n/** Sample one completion',a),env={}
 const read=p=>files[p]
 vm.runInNewContext(source.slice(a,b)+'\nloadEnvLocal()', {fs:{readFileSync:read},path,TRAIN_REPO:'/fixture',HERE:'/fixture/training',process:{env},loadTrainingEnv:dir=>loadTrainingEnv(dir,env,read)})
 assert.equal(env.TINKER_API_KEY,'training-fixture')
})
