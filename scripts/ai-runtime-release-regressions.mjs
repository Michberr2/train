import assert from 'node:assert/strict'
import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs'
import{tmpdir}from'node:os'
import{execFileSync}from'node:child_process'
import{createHash}from'node:crypto'
import{readFileSync}from'node:fs'
import{checkAIRuntimeRelease}from'./check-ai-runtime-release.mjs'
const root=mkdtempSync(tmpdir()+'/nalu-ai-release-check-')
try{
 for(const path of['vendor','client','package/dist'])mkdirSync(root+'/'+path,{recursive:true})
 const source={package:'@nalu/ai-runtime',version:'1.0.0',sourceCommit:'a'.repeat(40),dirty:false}
 writeFileSync(root+'/package/dist/release.json',JSON.stringify(source));execFileSync('tar',['-czf',root+'/vendor/runtime.tgz','-C',root,'package'])
 const metadata={...source,sourceRepository:'https://github.com/Michberr2/naluai',development:false,archive:'runtime.tgz',sha256:createHash('sha256').update(readFileSync(root+'/vendor/runtime.tgz')).digest('hex')}
 const dependency='file:../vendor/runtime.tgz',write=value=>writeFileSync(root+'/vendor/nalu-ai-release.json',JSON.stringify(value))
 write(metadata);writeFileSync(root+'/client/package.json',JSON.stringify({dependencies:{'@nalu/ai-runtime':dependency}}));writeFileSync(root+'/package-lock.json',JSON.stringify({packages:{client:{dependencies:{'@nalu/ai-runtime':dependency}}}}))
 assert.equal(checkAIRuntimeRelease(root).sourceCommit,source.sourceCommit)
 for(const patch of[{dirty:true},{development:true},{sha256:'0'.repeat(64)},{sourceCommit:'b'.repeat(40)},{archive:'../runtime.tgz'},{version:'1.0.0-dev.1'}]){write({...metadata,...patch});assert.throws(()=>checkAIRuntimeRelease(root))}
 write(metadata);writeFileSync(root+'/package-lock.json',JSON.stringify({packages:{client:{dependencies:{'@nalu/ai-runtime':'file:../vendor/old.tgz'}}}}));assert.throws(()=>checkAIRuntimeRelease(root))
 console.log('PASS AI release guard rejects dirty/development sources, changed bytes, mismatched revisions and stale lockfiles')
}finally{rmSync(root,{recursive:true,force:true})}
