import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import {chromium,expect} from '@playwright/test'
const noKey=process.argv.includes('--no-key')
const root=fileURLToPath(new URL('../client/',import.meta.url)),out='/tmp/nalu-map-fallback-checks'
await mkdir(out,{recursive:true})
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import MapPanel from '/src/components/workspace/MapPanel.tsx';import '/src/globals.css';createRoot(document.getElementById('root')).render(<React.StrictMode><div style={{height:'650px',width:'100%'}}><MapPanel request={{key:1,query:'restaurants in Dallas',mode:'places'}}/></div></React.StrictMode>);`
const server=await createServer({root,configFile:false,cacheDir:out+'/vite-cache',define:{'import.meta.env.VITE_GOOGLE_MAPS_KEY':JSON.stringify(noKey?'':'blocked-sdk-fixture'),'import.meta.env.VITE_GOOGLE_MAPS_KEY2':JSON.stringify('')},plugins:[react(),{name:'map-failure-fixture',configureServer(vite){vite.middlewares.use('/__map-failure',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__map-failure','<div id="root"></div><script type="module" src="/@map-failure"></script>'))})},resolveId:id=>id==='/@map-failure'?'\0map-failure':undefined,load:id=>id==='\0map-failure'?entry:undefined,transform:async(code,id)=>id==='\0map-failure'?(await import('esbuild')).transform(code,{loader:'jsx'}):undefined}],server:{host:'127.0.0.1',port:0,hmr:false}})
await server.listen();const base='http://127.0.0.1:'+server.httpServer.address().port
const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1200,height:800},reducedMotion:'reduce'})
let service='healthy',tileFailure=false,searches=0,sdkFailures=0
const places=[{name:'Fixture One',address:'Dallas, Texas',lat:32.78,lng:-96.8},{name:'Fixture Two',address:'Dallas, Texas',lat:32.79,lng:-96.79}]
const errors=[]
await context.addInitScript(()=>{localStorage.setItem('nalu-data-owner','isolated-map-owner');localStorage.setItem('nalu-token','isolated-map-token')})
await context.route('**/*',async route=>{
 const u=new URL(route.request().url())
 if(u.hostname==='maps.googleapis.com'){sdkFailures++;return route.abort()}
 if(u.hostname==='tile.openstreetmap.org')return tileFailure?route.abort():route.fulfill({contentType:'image/png',headers:{'Cache-Control':'public,max-age=604800'},body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7QAAAABJRU5ErkJggg==','base64')})
 if(u.origin===base&&u.pathname==='/api/web'){searches++;return route.fulfill({status:service==='healthy'?200:503,json:service==='healthy'?{source:'osm',results:places}:{error:'Synthetic provider outage'}})}
 if(u.origin===base)return route.continue()
 return route.abort()
})
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
try{
 await page.goto(base+'/__map-failure')
 await expect(page.getByRole('region',{name:'Resilient map workspace'})).toBeVisible({timeout:30000})
 await expect(page.getByRole('button',{name:'Map pin: Fixture One',exact:true})).toBeVisible()
 assert.equal(sdkFailures>0,!noKey)
 const map=page.getByRole('region',{name:'Interactive fallback map'})
 await expect(page.getByRole('link',{name:'© OpenStreetMap contributors',exact:true})).toBeVisible()
 await page.getByRole('button',{name:'Zoom out',exact:true}).click()
 await expect(page.locator('.fallback-map-coordinate')).toContainText('zoom')
 await page.getByRole('button',{name:'Map pin: Fixture One',exact:true}).click()
 await expect(page.getByRole('link',{name:'Open directions',exact:false})).toHaveAttribute('href',/query=32.78%2C-96.8/)
 await page.getByRole('button',{name:'Close selected place'}).click()
 const box=await map.boundingBox();const before=await page.locator('.fallback-map-coordinate').innerText()
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+70,box.y+box.height/2+45);await page.mouse.up()
 assert.notEqual(await page.locator('.fallback-map-coordinate').innerText(),before)
 await page.getByRole('button',{name:'Fit places',exact:true}).click()
 service='down';const previous=searches
 await page.getByRole('button',{name:'Search',exact:true}).click()
 await expect(page.getByText(/^Saved results from/)).toBeVisible()
 assert.equal(searches-previous,2)
 await expect(page.getByRole('button',{name:'Map pin: Fixture One',exact:true})).toBeVisible()
 tileFailure=true
 await page.getByRole('button',{name:'Zoom in',exact:true}).click()
 await page.getByRole('button',{name:'Zoom in',exact:true}).click()
 await expect(page.getByText(/Some street tiles are unavailable/)).toBeVisible()
 await page.getByRole('button',{name:'Fit places',exact:true}).click()
 await expect(page.getByRole('button',{name:'Map pin: Fixture One',exact:true})).toBeVisible()
 await page.screenshot({path:out+'/provider-outage.png'})
 await context.setOffline(true)
 await expect(page.getByText(/Offline: saved locations/)).toBeVisible()
 await page.getByRole('button',{name:'Search',exact:true}).click()
 await expect(page.getByText(/^Saved results from/)).toBeVisible()
 await page.getByRole('button',{name:'Zoom in',exact:true}).click()
 await page.screenshot({path:out+'/offline.png'})
 service='healthy';tileFailure=false;places.push({name:'Fixture Three',address:'Dallas',lat:32.785,lng:-96.795})
 await context.setOffline(false)
 await expect(page.getByRole('button',{name:'Show Fixture Three on map'})).toBeVisible()
 await expect(page.getByText(/^Saved results from/)).toHaveCount(0)
 await page.getByRole('button',{name:'Retry full map',exact:true}).click()
 await expect(page.getByRole('region',{name:'Resilient map workspace'})).toBeVisible()
 await expect(page.getByRole('button',{name:'Map pin: Fixture One',exact:true})).toBeVisible()
 assert.deepEqual(errors,[])
 console.log(noKey?'PASS missing Google key uses the full resilient map recovery path':'PASS blocked Google SDK automatically opens a key-free map; live results, directions, zoom and drag work; failed search uses scoped saved results; failed tiles and offline retain pins/controls; reconnection refreshes; retrying a broken provider recovers')
}catch(error){await page.screenshot({path:out+'/failure.png'}).catch(()=>{});await writeFile(out+'/failure.json',JSON.stringify({errors,text:await page.locator('body').innerText()},null,2));throw error}
finally{await context.close();await browser.close();await server.close()}
