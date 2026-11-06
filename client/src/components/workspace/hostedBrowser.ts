import { getToken } from '../../lib/localAuth'
let onlineToken: string | null = null
const starting = new Map<string,Promise<any>>()
export const hostedOnlineAIAllowed = () => !!getToken() && onlineToken === getToken()
export function allowHostedOnlineAI(allowed:boolean) { onlineToken = allowed ? getToken() : null }
const localOnly = () => { try{return JSON.parse(localStorage.getItem('device-local-ai-v1')||'{}').enabled!==false}catch{return true} }
export async function hostedBrowserRequest(action:string,data:Record<string,unknown>={},signal?:AbortSignal,token=getToken()) {
  if(!token || token!==getToken())throw Error('Sign in again to access your browser.')
  if(['workspace_run','workspace_resume'].includes(action)&&localOnly()&&!hostedOnlineAIAllowed())throw Error('Allow online AI for browser tasks to let Nalu work here. Other AI stays local; no page data was sent to a model.')
  const response=await fetch('/api/browser',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({...data,action:'host_'+action}),signal})
  const value=await response.json()
  if(token!==getToken())throw Error('Your account changed. Open Browser again.')
  if(!response.ok)throw Object.assign(Error(value.error||'Your browser is temporarily unavailable.'),{status:response.status})
  if(action==='disconnect')onlineToken=null
  return value
}
// Opening is idempotent. Sharing the startup promise avoids duplicate allocations
// across React effect remounts. Tasks are never automatically retried.
export function ensureHostedBrowser(token:string) {
  if(!starting.has(token))starting.set(token,(async()=>{
    for(let attempt=0;attempt<30;attempt++){
      try{return await hostedBrowserRequest('workspace_open',{},undefined,token)}
      catch(error:any){if(error.status!==409||attempt===29)throw error;await new Promise(resolve=>setTimeout(resolve,1000))}
    }
  })().finally(()=>starting.delete(token)))
  return starting.get(token)!
}
