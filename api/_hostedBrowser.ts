import type { Sandbox } from '@vercel/sandbox'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readToken } from './_db'
import { connectionBackend } from './_connectionBackend'
import { BrowserWorkspaceStore } from './_browserWorkspaceStore'
import { reserveDailyQuota } from './_limits'

export const HOSTED_BROWSER_ACTIONS = new Set(['workspace_status','workspace_screen','workspace_open','workspace_run','workspace_resume','workspace_takeover','workspace_close','workspace_input','workspace_tab','disconnect'])
const starts = new Set(['workspace_open','workspace_run','workspace_resume'])
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve,ms))
const idle = (agent = 'main') => ({configured:true,runtime:'hosted',active:false,status:'idle',agent_id:agent,image:null,agents:[{id:agent,status:'idle',active:false}]})
export function hostedIdentity(owner: string, secret: string) {
  if (!owner || secret.length < 16) throw Error('Browser hosting identity is unavailable.')
  const digest = (purpose: string) => createHmac('sha256',secret).update(`nalu-hosted-browser-v1:${purpose}:${owner}`).digest('hex')
  return {name:'nalu-browser-'+digest('name').slice(0,40),key:digest('access')}
}
export function validateHostedRequest(body: any) {
  const action = String(body.action || '').replace(/^host_/,'')
  if (!HOSTED_BROWSER_ACTIONS.has(action)) throw Error('Unknown browser action.')
  if (body.agent_id != null && (typeof body.agent_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.agent_id))) throw Error('Invalid browser agent.')
  if (Buffer.byteLength(JSON.stringify(body)) > 40000) throw Error('Browser request is too large.')
  if (action === 'workspace_run' && (typeof body.task !== 'string' || !body.task.trim() || body.task.length > 6000)) throw Error('Provide a browser task of up to 6000 characters.')
  if(body.url){const url=new URL(body.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Use a public website address.')}
  return action
}
const defaults = { Sandbox: undefined as typeof import('@vercel/sandbox').Sandbox | undefined, connectionBackend, reserveDailyQuota, Store: BrowserWorkspaceStore, readFile, wait }
export async function hostedBrowser(req: any,res: any,body: any,deps = defaults) {
  let action: string
  try { action=validateHostedRequest(body) } catch(error) {return res.status(400).json({error:(error as Error).message})}
  const token=readToken(req)
  if(!token)return res.status(401).json({error:'Sign in to access your browser.'})
  let backend:ReturnType<typeof connectionBackend>|undefined,store:BrowserWorkspaceStore|undefined,lease='',owner=''
  let quota:Awaited<ReturnType<typeof reserveDailyQuota>>|undefined, accepted=false
  try {
    backend=deps.connectionBackend();await backend.connect();owner=await backend.userId(token)||''
    if(!owner)return res.status(401).json({error:'Sign in again to access your browser.'})
    const identity=hostedIdentity(owner,process.env.NALU_SESSION_SECRET || '')
    const snapshotId=process.env.NALU_BROWSER_SNAPSHOT_ID
    if(!snapshotId)return res.status(503).json({error:'Automatic browser hosting is being prepared. Please try again shortly.'})
    // Screen/status reads never allocate or change the provider session. They
    // must not hold the mutation lease and reject a simultaneous task submission.
    if(!['workspace_status','workspace_screen'].includes(action)){
      store=new deps.Store(backend.client);await store.init()
      const claim=await store.claim(owner)
      if(!claim)return res.status(409).json({error:'Your browser is starting or handling another request. Please wait.',status:'starting'})
      lease=claim.lease
    }
    // Preserve the SDK's ESM entry: its serializer cannot be loaded with require().
    const SandboxClient = deps.Sandbox || (await import('@vercel/sandbox')).Sandbox
    let sandbox:Sandbox|undefined
    try {sandbox=await SandboxClient.get({name:identity.name,resume:false})}
    catch(error:any){if(error?.response?.status!==404)throw error}
    const running=sandbox?.status==='running'
    if(!running && !starts.has(action))return res.status(200).json({...idle(body.agent_id),...(sandbox?{status:'paused',detail:'Your browser is paused. Open it to continue.'}:{})})
    const call = async (host:Sandbox,operation:string,timeout=35000) => {
      const response=await fetch(host.domain(8877)+'/browser',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${identity.key}`},body:JSON.stringify({owner,token,action:operation,data:body}),signal:AbortSignal.timeout(timeout)})
      const value=await response.json()
      if(!response.ok)throw Object.assign(Error(typeof value.error==='string'?value.error:'Browser operation failed.'),{publicStatus:response.status})
      return value
    }
    if(!running){
      quota=await deps.reserveDailyQuota(req,'hosted-browser-session',{anonPerDay:0,userPerDay:6})
      if(!quota.ok)return res.status(quota.status||429).json({error:quota.reason==='unavailable'?'Browser capacity checks are temporarily unavailable.':'Today’s browser session allowance is used. Your saved browser profile is retained.'})
      const start=async(host:Sandbox)=>{
        const content=await deps.readFile(join(process.cwd(),'services/browser-cloud/runtime.cjs'))
        await host.writeFiles([{path:'/vercel/sandbox/nalu-browser.cjs',content}])
        await host.runCommand({cmd:'node',args:['/vercel/sandbox/nalu-browser.cjs'],detached:true,env:{NALU_BROWSER_OWNER:owner,NALU_BROWSER_KEY:identity.key,NALU_BROWSER_EXPIRES:String(host.expiresAt?.getTime()||Date.now()+900000),BROWSER_DATA_DIR:'/vercel/sandbox/browser-data',BROWSER_MAX_SESSIONS:'2'}})
        let ready=false
        for(let attempt=0;attempt<40;attempt++){try{await call(host,'workspace_status',3000);ready=true;break}catch{await deps.wait(500)}}
        if(!ready){await host.stop().catch(()=>{});throw Error('Browser startup did not finish.')}
      }
      // A lost creation response can still have allocated a machine. Keep the
      // reservation once submitted, rather than allowing unlimited costly retries.
      accepted=true
      sandbox=await SandboxClient.getOrCreate({name:identity.name,source:{type:'snapshot',snapshotId},resume:true,persistent:true,timeout:900000,resources:{vcpus:2},ports:[8877],snapshotExpiration:30*24*60*60*1000,keepLastSnapshots:{count:1},tags:{service:'nalu-browser'},onCreate:start,onResume:start})
      accepted=true
    }
    if(!sandbox)throw Error('Browser session is unavailable.')
    if(action==='disconnect'){
      await call(sandbox,'shutdown');await sandbox.stop()
      return res.status(200).json({...idle(body.agent_id),status:'paused'})
    }
    // Reopening the view must not restart or reject an already-working agent.
    if(action==='workspace_open' && !body.url){
      const current=await call(sandbox,'workspace_status')
      if(current.active)return res.status(200).json({...current,...await call(sandbox,'workspace_screen')})
    }
    const value=await call(sandbox,action)
    // Return the first frame with startup instead of waiting for another poll.
    if(action==='workspace_open' && value.active){
      try{return res.status(200).json({...value,...await call(sandbox,'workspace_screen')})}
      catch{/* Opening succeeded; a later screen poll can recover. */}
    }
    return res.status(200).json(value)
  }catch(error:any){
    // Never return SDK errors: provider URLs and authentication metadata are private.
    if(error?.publicStatus)return res.status(error.publicStatus>=500?503:400).json({error:error.message})
    return res.status(error?.response?.status===429?429:503).json({error:error?.response?.status===429?'Browser hosting is at capacity. Please try again shortly.':'Nalu could not start or reach your browser. Please try again.',status:'unavailable'})
  }finally{
    if(quota?.ok&&!accepted)await quota.release().catch(()=>{})
    if(store&&lease)await store.release(owner,lease).catch(()=>{})
    await backend?.close().catch(()=>{})
  }
}
