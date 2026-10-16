// Agent pipeline outputs — files a flow produced (documents, decks, workbooks,
// emails). Browser-produced bytes live in IndexedDB; scheduled output files live
// in account storage. Both appear in Outputs and can be downloaded on demand.
import { getToken } from '../../lib/localAuth'

export type OutputMeta = {
  id: string
  flowId: string
  flowName: string
  nodeLabel: string
  kind: 'doc' | 'pdf' | 'slides' | 'sheet' | 'csv' | 'email' | 'website' | 'image' | 'video' | 'text' | 'calendar' | 'mailrules' | 'contacts'
  filename: string
  size: number
  ts: number
  storage?: 'server'
  phoneSynced?: boolean
  runId?: string
  nodeId?: string
}

const DB_NAME = 'nalu-agent-outputs'
const STORE = 'files'
const META_KEY = 'nalu-agent-output-meta'
const REMOTE_META_KEY = 'nalu-agent-output-remote-meta'
const MAX_OUTPUTS = 60

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function readMeta(key: string): OutputMeta[] {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || '[]') as OutputMeta[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

const localCatalog = () => readMeta(META_KEY).filter((meta) => meta.storage !== 'server')
const remoteCatalog = () => {
  // Accept metadata cached before the catalogs were separated. A successful
  // refresh replaces this fallback without changing any device-local records.
  try {
    if (localStorage.getItem(REMOTE_META_KEY) != null) return readMeta(REMOTE_META_KEY)
  } catch { /* unavailable localStorage */ }
  return readMeta(META_KEY).filter((meta) => meta.storage === 'server')
}
export function listOutputs(): OutputMeta[] {
  return [...remoteCatalog(), ...localCatalog()].sort((a, b) => b.ts - a.ts).slice(0, MAX_OUTPUTS)
}

function saveMeta(key: string, metas: OutputMeta[]) {
  try { localStorage.setItem(key, JSON.stringify(metas.slice(0, MAX_OUTPUTS))) } catch { /* quota */ }
}

async function savedOutputRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken()
  if (!token) throw new Error('Sign in to access saved outputs.')
  const response = await fetch(`/api/artifacts${path}`, {
    ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
  })
  if (getToken() !== token) throw new Error('Your account changed. Please open Outputs again.')
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}))
    throw new Error(detail.error || 'Saved outputs are temporarily unavailable. Please try again.')
  }
  return response
}

/** Refresh metadata only. The download request fetches bytes with the current
 * account's token; remote files never depend on another device's IndexedDB. */
export async function refreshOutputs(): Promise<OutputMeta[]> {
  await syncPhoneOutputs()
  if (!getToken()) return listOutputs()
  const token = getToken()
  const response = await savedOutputRequest('')
  const body = await response.json()
  if (getToken() !== token) return listOutputs()
  if (!Array.isArray(body.outputs)) throw new Error('Could not load saved outputs. Please try again.')
  const remote = (body.outputs as OutputMeta[]).filter((meta) => meta.storage === 'server' && /^artifact_[a-f0-9]{64}$/.test(meta.id))
  // Limit the displayed merge, not the local catalog: newer server files must
  // never erase the only index of still-existing IndexedDB bytes.
  saveMeta(REMOTE_META_KEY, remote)
  return listOutputs()
}

let phoneSync:Promise<void>|null=null
async function syncPhoneOutputs():Promise<void> {
  if(phoneSync)return phoneSync
  const token=getToken();if(!token)return
  phoneSync=(async()=>{
    const pending=localCatalog().filter(m=>!m.phoneSynced);if(!pending.length)return
    const r=await fetch('/api/data',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'load',token})})
    if(!r.ok)throw new Error('Could not sync existing output files to your phone.')
    let flows=(await r.json()).data?.['nalu-agent-flows']
    for(let i=0;i<6&&typeof flows==='string';i++){try{flows=JSON.parse(flows)}catch{flows=[]}}
    const owned=new Set<string>()
    if(Array.isArray(flows))for(const f of flows)for(const a of Object.values(f.artifacts||{}) as OutputMeta[])if(a?.id)owned.add(a.id)
    for(const meta of pending){
      if(getToken()!==token)throw new Error('Your account changed. Open Outputs again.')
      // Legacy IndexedDB had no owner column. Only migrate files explicitly
      // referenced by this authenticated account's stored flow artifacts.
      if(!owned.has(meta.id))continue
      const blob=await getOutputBlob(meta.id);if(!blob)continue
      await uploadPhoneAttachment(meta,blob)
      saveMeta(META_KEY,localCatalog().map(m=>m.id===meta.id?{...m,phoneSynced:true}:m))
    }
  })().finally(()=>{phoneSync=null})
  return phoneSync
}

/** Upload original bytes, in retry-safe chunks, before reporting the output saved. */
async function uploadPhoneAttachment(meta:OutputMeta,blob:Blob):Promise<void> {
  const token=getToken();if(!token)throw new Error('Sign in to save this output to your phone.')
  const call=async(body:Record<string,unknown>)=>{
    if(getToken()!==token)throw new Error('Your account changed. Open Outputs again.')
    const r=await fetch('/api/task-attachments',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)})
    const d=await r.json();if(getToken()!==token)throw new Error('Your account changed. Open Outputs again.')
    if(!r.ok)throw new Error(d.error||'Could not save output to your account.');return d
  }
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('')
  const {attachment}=await call({action:'begin',meta:{sourceId:meta.id,flowId:meta.flowId,taskId:meta.runId,title:meta.nodeLabel,filename:meta.filename,mime:blob.type.split(';')[0],size:blob.size,sha256:digest}})
  for(let part=0;part<attachment.parts;part++){
    const bytes=new Uint8Array(await blob.slice(part*786432,(part+1)*786432).arrayBuffer())
    let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192))
    await call({action:'part',id:attachment.id,part,base64:btoa(binary)})
  }
  await call({action:'finish',id:attachment.id})
}

/** Persist an output file to the system (IndexedDB + meta index). Best-effort. */
export async function storeOutput(meta: OutputMeta, blob: Blob): Promise<void> {
  await uploadPhoneAttachment(meta,blob)
  meta={...meta,phoneSynced:true}
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ id: meta.id, blob })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    const metas = [meta, ...localCatalog().filter((m) => m.id !== meta.id)]
    // prune both stores past the cap
    const keep = metas.slice(0, MAX_OUTPUTS)
    saveMeta(REMOTE_META_KEY, remoteCatalog())
    saveMeta(META_KEY, keep)
    const dead = metas.slice(MAX_OUTPUTS)
    if (dead.length) {
      const tx = db.transaction(STORE, 'readwrite')
      for (const d of dead) tx.objectStore(STORE).delete(d.id)
    }
    db.close()
  } catch {
    /* storage unavailable — the auto-download still happened */
  }
}

export async function getOutputBlob(id: string): Promise<Blob | null> {
  const token = getToken()
  let blob: Blob | null = null
  if (id.startsWith('artifact_')) {
    blob = await (await savedOutputRequest(`?id=${encodeURIComponent(id)}`)).blob()
  } else {
    try {
      const db = await openDb()
      blob = await new Promise<Blob | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).get(id)
        req.onsuccess = () => resolve((req.result as { blob?: Blob } | undefined)?.blob || null)
        req.onerror = () => reject(req.error)
      })
      db.close()
    } catch { /* local storage unavailable */ }
  }
  // Headers may arrive long before the body, and IndexedDB is asynchronous.
  // Do not hand the previous account's bytes to a detached download callback.
  if (getToken() !== token) throw new Error('Your account changed. Please open Outputs again.')
  return blob
}

export async function deleteOutput(id: string): Promise<void> {
  if (id.startsWith('artifact_')) await savedOutputRequest('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id }) })
  saveMeta(REMOTE_META_KEY, remoteCatalog().filter((m) => m.id !== id))
  saveMeta(META_KEY, localCatalog().filter((m) => m.id !== id))
  try {
    const db = await openDb()
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)
    db.close()
  } catch { /* */ }
}

/** Trigger a browser download (lands in the user's Downloads folder). */
export function downloadBlobFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

/** Build a standards-compliant .eml draft (opens in Mail/Outlook when double-clicked). */
export function buildEmlBlob(to: string, subject: string, body: string): Blob {
  const eml = [
    `To: ${to || ''}`,
    `Subject: ${subject || 'From Nalu Agents'}`,
    'X-Unsent: 1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')
  return new Blob([eml], { type: 'message/rfc822' })
}

// ---- real-world work artifacts ----------------------------------------------

export { buildIcsBlob, type IcsEvent } from '../../../../shared/autopilotCalendar'

export { buildGmailFiltersXml, buildVcfBlob, type MailRule, type VcfContact } from '../../../../shared/autopilotFiles'

/** Open the user's mail client with a prefilled draft (body truncated to URL limits). */
export function openMailto(to: string, subject: string, body: string) {
  const url = `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body.slice(0, 1800))}`
  window.open(url, '_self')
}
