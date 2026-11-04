import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {basename,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
export function checkAIRuntimeRelease(root){
 const metadata=JSON.parse(readFileSync(resolve(root,'vendor/nalu-ai-release.json'),'utf8'))
 assert.equal(metadata.package,'@nalu/ai-runtime')
 assert.equal(metadata.sourceRepository,'https://github.com/Michberr2/naluai')
 assert.match(metadata.sourceCommit,/^[a-f0-9]{40}$/)
 assert.equal(metadata.dirty,false,'Commit the AI source before production publication')
 assert.equal(metadata.development,false,'Development AI packages cannot be deployed')
 assert.match(metadata.version,/^\d+\.\d+\.\d+$/,'Production requires a stable runtime version')
 assert.equal(basename(metadata.archive),metadata.archive,'Archive must be a vendor filename')
 const archive=resolve(root,'vendor',metadata.archive)
 assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'),metadata.sha256,'AI archive bytes do not match their source receipt')
 const release=JSON.parse(execFileSync('tar',['-xOf',archive,'package/dist/release.json'],{encoding:'utf8',maxBuffer:100000}))
 for(const key of ['package','version','sourceCommit','dirty'])assert.equal(release[key],metadata[key],'AI source receipt mismatch: '+key)
 const app=JSON.parse(readFileSync(resolve(root,'client/package.json'),'utf8'))
 assert.equal(app.dependencies['@nalu/ai-runtime'],'file:../vendor/'+metadata.archive)
 const lock=JSON.parse(readFileSync(resolve(root,'package-lock.json'),'utf8'))
 assert.equal(lock.packages.client.dependencies['@nalu/ai-runtime'],app.dependencies['@nalu/ai-runtime'],'Lockfile must consume this exact AI archive')
 return metadata
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const release=checkAIRuntimeRelease(fileURLToPath(new URL('../',import.meta.url)));console.log('PASS immutable AI runtime '+release.version+' from '+release.sourceCommit)}
