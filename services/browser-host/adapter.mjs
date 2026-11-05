import puppeteer from '@cloudflare/puppeteer/lib/esm/puppeteer/puppeteer-core.js'
import { chromium } from 'playwright-core'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
export const sessions=new Map(), viewers=new Map()
export const ownerHash=owner=>crypto.createHash('sha256').update(owner).digest('hex')
const dataDir=process.env.BROWSER_DATA_DIR||'/data'
const origin=process.env.BROWSER_PUBLIC_ORIGIN||'http://127.0.0.1:8877'
const maxSessions=Math.max(1,Math.min(4,Number(process.env.BROWSER_MAX_SESSIONS)||2))
let pendingSessions = 0
function wrap(record) {
  const wrapPage=page=>new Proxy(page,{get(target,key){
    if(key==='target')return()=>({createCDPSession:async()=>{
      const cdp=await page.target().createCDPSession()
      return new Proxy(cdp,{get(t,k){if(k==='send')return(method,...args)=>method==='Cloudflare.getLiveView'?Promise.resolve({devtoolsFrontendUrl:origin+'/view#'+record.token}):t.send(method,...args);const v=t[k];return typeof v==='function'?v.bind(t):v}})
    }})
    const v=target[key];return typeof v==='function'?v.bind(target):v
  }})
  return new Proxy(record.browser,{get(t,key){
    if(key==='sessionId')return()=>record.id
    if(key==='pages')return async()=> (await t.pages()).map(wrapPage)
    if(key==='newPage')return async()=>wrapPage(await t.newPage())
    if(key==='disconnect')return()=>{}
    if(key==='close')return async()=>{viewers.delete(record.token);sessions.delete(record.id);await t.close()}
    const v=t[key];return typeof v==='function'?v.bind(t):v
  }})
}
export default {
  async acquire(endpoint) {
    if(sessions.size + pendingSessions >= maxSessions)throw Error('429 Browser host capacity')
    pendingSessions++
    try {
    const id=crypto.randomUUID(), token=crypto.randomBytes(32).toString('base64url')
    const profile=path.join(dataDir,'profiles',ownerHash(endpoint.owner));await fs.mkdir(profile,{recursive:true,mode:0o700})
    await fs.mkdir(path.join(profile,'config'),{recursive:true,mode:0o700})
    const browser=await puppeteer.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||chromium.executablePath(),headless:true,userDataDir:profile,
      env:{PATH:process.env.PATH,HOME:'/home/pwuser',XDG_CONFIG_HOME:path.join(profile,'config'),XDG_CACHE_HOME:path.join(profile,'cache'),LANG:'en_US.UTF-8'},
      args:['--proxy-server=http://127.0.0.1:8878','--proxy-bypass-list=<-loopback>','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-extensions','--no-first-run'],
      defaultViewport:{width:1440,height:900}})
    const record={id,token,browser,owner:endpoint.owner,lastOwnerUse:Date.now()};sessions.set(id,record);viewers.set(token,record)
    browser.on('disconnected',()=>{sessions.delete(id);viewers.delete(token)})
    const guard=async page=>{await page.setRequestInterception(true);page.on('request',r=>{try{const protocol=new URL(r.url()).protocol;void (['http:','https:','data:','blob:','about:'].includes(protocol)?r.continue():r.abort())}catch{void r.abort()}})}
    await Promise.all((await browser.pages()).map(guard));browser.on('targetcreated',async t=>{if(t.type()==='page'){const p=await t.page();if(p)await guard(p).catch(()=>{})}})
    return{sessionId:id}
    } finally { pendingSessions-- }
  },
  async connect(endpoint,id){const r=sessions.get(id);if(!r||r.owner!==endpoint.owner)throw Error('Browser closed');r.lastOwnerUse=Date.now();return wrap(r)},
  async limits(){return{maxConcurrentSessions:maxSessions,activeSessions:sessions.size}},
}
