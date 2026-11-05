import assert from 'node:assert/strict'
import {build} from 'esbuild'
const bundle=await build({entryPoints:['client/src/components/workspace/mapReliability.ts'],bundle:true,write:false,format:'esm',platform:'node'})
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const data=new Map([['nalu-data-owner','owner-a'],['nalu-token','token-a']])
globalThis.localStorage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}
const originalFetch=globalThis.fetch
let calls=0
try{
 assert.deepEqual(api.placeRequest('restaurants in Dallas',{lat:28,lng:-81}),{action:'places',query:'restaurants',near:'Dallas'})
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({source:'osm',results:[{name:'Fixture Dallas place',address:'Dallas',lat:32.78,lng:-96.8}]}),{headers:{'content-type':'application/json'}})}
 const live=await api.reliablePlaces('restaurants in Dallas')
 assert.equal(live.cached,false);assert.equal(live.results.length,1)
 globalThis.fetch=async()=>{calls++;throw new TypeError('network offline')}
 const saved=await api.reliablePlaces('restaurants in Dallas')
 assert.equal(saved.cached,true);assert.equal(saved.results[0].name,'Fixture Dallas place');assert.equal(calls,3)
 assert.equal(api.cachedPlaces('restaurants in Boston'),null)
 data.set('nalu-data-owner','owner-b');data.set('nalu-token','token-b')
 assert.equal(api.cachedPlaces('restaurants in Dallas'),null)
 await assert.rejects(api.reliablePlaces('restaurants in Dallas'),/temporarily unavailable/)
 data.set('nalu-data-owner','owner-a');data.set('nalu-token','token-a')
 let resolveFetch
 globalThis.fetch=()=>new Promise(resolve=>{resolveFetch=resolve})
 const changed=api.reliablePlaces('coffee in Dallas')
 data.set('nalu-data-owner','owner-b');data.set('nalu-token','token-b')
 resolveFetch(new Response(JSON.stringify({results:[{name:'Private fixture',lat:32.7,lng:-96.8}]})))
 await assert.rejects(changed,/Account or search changed/)
 assert.equal(api.cachedPlaces('coffee in Dallas'),null)
 for(const [lat,lng] of [[0,0],[32.78,-96.8],[-33.8,151.2],[80,179.9]])for(const zoom of [2,8,18]){const p=api.project(lat,lng,zoom),r=api.unproject(p.x,p.y,zoom);assert.ok(Math.abs(r.lat-lat)<.00001);assert.ok(Math.abs(r.lng-lng)<.00001)}
 console.log('PASS bounded read-only search retries, saved-result fallback, explicit-city precedence, account isolation, stale-response rejection and key-free map projection')
}finally{globalThis.fetch=originalFetch;delete globalThis.localStorage}
