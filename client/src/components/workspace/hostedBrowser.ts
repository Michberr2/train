import { getToken } from '../../lib/localAuth'
const starting = new Map<string,Promise<any>>()
export async function hostedBrowserRequest(action:string,data:Record<string,unknown>={},signal?:AbortSignal,token=getToken()) {
  if(!token || token!==getToken())throw Error('Sign in again to access your browser.')
  const deadline=AbortSignal.timeout(action==='workspace_open'?45000:35000)
  const requestSignal=signal?AbortSignal.any([signal,deadline]):deadline
  const response=await fetch('/api/browser',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({...data,action:'host_'+action}),signal:requestSignal})
  const value=await response.json()
  if(token!==getToken())throw Error('Your account changed. Open Browser again.')
  if(!response.ok)throw Object.assign(Error(value.error||'Your browser is temporarily unavailable.'),{status:response.status})
  return value
}
// Opening is idempotent. Sharing the startup promise avoids duplicate allocations
// across React effect remounts. Tasks are never automatically retried.
export function ensureHostedBrowser(token:string) {
  if(!starting.has(token))starting.set(token,(async()=>{
    const deadline=AbortSignal.timeout(45000)
    for(let attempt=0;attempt<30;attempt++){
      try{return await hostedBrowserRequest('workspace_open',{},deadline,token)}
      catch(error:any){if(error.status!==409||attempt===29)throw error;await new Promise(resolve=>setTimeout(resolve,1000))}
    }
  })().catch(error=>{if(error?.name==='TimeoutError')throw Error('Browser connection timed out. Open the browser again to reconnect; your existing session may still be starting.');throw error}).finally(()=>starting.delete(token)))
  return starting.get(token)!
}
