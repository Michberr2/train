// In-process real handler + synthetic transports. Never calls a model or DB.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { getEventListeners } from 'node:events'

const contextPath = `${process.cwd()}/api/_swarmStudioContext.ts`
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `export * from './api/_swarmStudio'; export * from './api/_swarmStudioContext'; export {cancellationSignal} from './api/_requestCancellation'; export async function loadDoc(){return (await import('./api/doc')).default}` },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'offline-transports', setup(b) {
    b.onResolve({ filter: /^\.\/(?:_swarmStore|_db|_limits|_llm|_accountContext|_grounding|_studioGeneration)$|^@vercel\/functions$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
      const context = `import {excludeSwarmStudioIdentity,swarmStudioInvocation,recordSwarmStudioQuota} from ${JSON.stringify(contextPath)};`
      const contents = path === './_swarmStore' ? 'export const SWARM_MAX_STATE_BYTES=3000000;export const SWARM_MAX_SNAPSHOT_BYTES=12000000;'
        : path === '@vercel/functions' ? 'export const waitUntil=p=>globalThis.studioFixture.waits.push(p);'
        : path === './_db' ? `${context} export const identityForRequest=async(req)=>{if(globalThis.studioFixture.leakIdentity)return {id:'other-account',name:'PRIVATE_PROFILE',profile:'PRIVATE_PROFILE'};if(excludeSwarmStudioIdentity())return null;throw Error('Unexpected personal identity lookup')};export const identityBlock=who=>who?who.profile:'';`
        : path === './_limits' ? `${context}export const reserveStudioQuota=async(req,kind)=>globalThis.studioFixture.reserve(kind,swarmStudioInvocation()?.ownerId);export const studioLimitMessage=()=> 'Usage unavailable';`
        : path === './_llm' ? 'export const providerChain=()=>[{}];'
        : path === './_accountContext' ? `export const accountContextForUser=async()=>{globalThis.studioFixture.accountReads++;return 'PRIVATE_ACCOUNT_MEMORY'};`
        : path === './_grounding' ? `export const groundResearch=async()=>({text:'',status:'not-needed',sources:[],checkedAt:'2026-10-18'});`
        : `export const generateStudioJson=async options=>{const messages=options.messages(0);globalThis.studioFixture.prompts.push(messages);return options.parse(JSON.stringify({title:'Launch brief',subtitle:'Approved work',cover:'',blocks:[{type:'p',text:'Use the approved launch direction.'}]}))};`
      return { contents, resolveDir: process.cwd() }
    })
  } }],
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Swarm Studio tests cannot use network transports') }
const now = 1000
function state(kind = 'document', owner = 'owner-a', thread = 'Rocky') {
  const source = { id: 'source', projectId: 'project', thread, kind: 'task', taskId: 'task', speaker: thread, status: 'waiting', input: 'Create the launch artifact.', requestId: 'source-request', createdAt: 300, updatedAt: 400, attempts: 1,
    artifact: { type: 'needs-workspace', workspace: 'studio', studioKind: kind, prompt: 'Create the launch artifact.', reason: 'Use Studio.' } }
  return { owner, revision: 1, state: { version: 1, mode: 'live', projects: [{ id: 'project', title: 'Launch', brief: `${owner}:PROJECT_BRIEF`, members: ['Nalu', 'Rocky', 'Milo'], createdAt: 1, updatedAt: 1 }], tasks: [{ id: 'task', projectId: 'project', title: 'Launch artifact', summary: 'Waiting', assignee: thread, threads: [thread], status: 'running', executionId: 'generation', updatedAt: 400 }], turns: [], messages: [
    { id: 'own', projectId: 'project', thread, speaker: 'You', content: `${owner}:APPROVED_CONTEXT`, createdAt: 100 },
    { id: 'other', projectId: 'project', thread: thread === 'Rocky' ? 'Milo' : 'Rocky', speaker: 'You', content: 'UNRELATED_PRIVATE_CONVERSATION', createdAt: 100 },
  ] }, jobs: [source, { ...source, id: 'generation', status: 'running', requestId: 'generation-request', createdAt: 500, updatedAt: 500, leaseToken: `${owner}-lease`, leaseUntil: 100000,
    artifact: { type: 'studio-generation', sourceJobId: 'source', studioKind: kind } }] }
}
function fixture() {
  const f = { waits: [], prompts: [], accountReads: 0, releases: [], reservations: [], leakIdentity: false,
    reserve: async (kind, owner) => {
      const receipt = { owner, kind, refunded: false }; f.reservations.push(receipt)
      return api.recordSwarmStudioQuota(owner, kind, { ok: true, signedIn: true, release: async () => { if (!receipt.refunded) { receipt.refunded = true; f.releases.push(receipt) } } })
    },
  }
  globalThis.studioFixture = f
  return f
}
function harness(kind = 'document', owner = 'owner-a', thread = 'Rocky') {
  let saved = state(kind, owner, thread), commits = 0
  const store = { read: async readOwner => { assert.equal(readOwner, owner); return structuredClone(saved) },
    mutateLeased: async (writeOwner, jobId, token, mutation) => {
      assert.equal(writeOwner, owner)
      const job = saved.jobs.find(j => j.id === jobId)
      if (!job || job.status !== 'running' || job.leaseToken !== token || job.leaseUntil <= now) return null
      const draft = structuredClone(saved); mutation(draft); saved = draft; commits++; return structuredClone(saved)
    } }
  const options = { store, ownerId: owner, request: { sourceJobId: 'source', taskId: 'task', expectedStudioKind: kind, executionId: 'generation', leaseToken: `${owner}-lease` }, now: () => now,
    persist: (draft, scope, artifact) => { assert.equal(scope.ownerId, owner); const job = draft.jobs.find(j => j.id === scope.lease.jobId); job.artifact = artifact; job.status = artifact.status; draft.state.tasks[0].status = artifact.status },
  }
  return { options, cancel: () => { saved.jobs[1].status = 'cancelled'; saved.state.tasks[0].status = 'cancelled' }, saved: () => saved, commits: () => commits }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'asynchronous stage started') }
let count = 0
const check = async (name, fn) => { await fn(); count++; console.log(`PASS ${name}`) }
const mockHandler = (payload, quota = 'design', identity = true) => async (req, res) => {
  assert.deepEqual(Object.keys(req.headers), ['content-type'], 'synthetic generation has no bearer/account headers')
  if (identity) api.excludeSwarmStudioIdentity()
  await globalThis.studioFixture.reserve(quota, api.swarmStudioInvocation().ownerId)
  res.status(200).json(payload)
}
try {
  await check('raw existing handlers remain unavailable until both shared hooks are installed', async () => {
    fixture(); const h = harness(); let called = false
    await assert.rejects(api.executeSwarmStudio({ ...h.options, handlers: { doc: () => { called = true } } }), /not installed/)
    api.registerSwarmStudioHook('identity')
    await assert.rejects(api.executeSwarmStudio({ ...h.options, handlers: { doc: () => { called = true } } }), /not installed/)
    assert.equal(called, false); assert.equal(h.commits(), 0)
    api.registerSwarmStudioHook('quota')
  })
  await check('real document handler gets scoped brief/context and preserves generation/validation output', async () => {
    const f = fixture(), h = harness(), doc = await api.loadDoc()
    const result = await api.executeSwarmStudio({ ...h.options, handlers: { doc } })
    assert.equal(result.status, 'done'); assert.equal(result.payload.title, 'Launch brief')
    assert.ok(result.payload.blocks.length && result.payload.design)
    assert.equal(h.commits(), 1); assert.equal(f.accountReads, 0); assert.equal(f.releases.length, 0)
    assert.ok(f.prompts.length >= 2, 'real final fidelity review is retained')
    const text = JSON.stringify(f.prompts)
    assert.match(text, /owner-a:PROJECT_BRIEF/); assert.match(text, /owner-a:APPROVED_CONTEXT/)
    assert.doesNotMatch(text, /PRIVATE_PROFILE|PRIVATE_ACCOUNT_MEMORY|UNRELATED_PRIVATE_CONVERSATION/)
    assert.deepEqual(f.reservations.map(x => [x.owner, x.kind]), [['owner-a', 'doc']])
  })
  await check('registered but bypassed identity policy cannot save an artifact', async () => {
    const f = fixture(), h = harness(); f.leakIdentity = true
    await assert.rejects(api.executeSwarmStudio({ ...h.options, handlers: { doc: await api.loadDoc() } }), /required Swarm identity/)
    assert.equal(h.commits(), 0); assert.equal(f.releases.length, 1)
    // This deliberate broken-hook fixture proves the suite can observe an
    // escaped profile/account lookup; the success test above forbids both.
    assert.equal(f.accountReads, 1); assert.match(JSON.stringify(f.prompts), /PRIVATE_PROFILE/)
  })
  await check('wrong-owner or anonymous quota receipt fails before provider generation', async () => {
    for (const owner of ['owner-b', null]) {
      const f = fixture(), h = harness(); let providerCalled = false
      await assert.rejects(api.executeSwarmStudio({ ...h.options, handlers: { doc: async () => {
        api.excludeSwarmStudioIdentity(); await f.reserve('doc', owner); providerCalled = true
      } } }), /authenticated owner/)
      assert.equal(providerCalled, false); assert.equal(h.commits(), 0)
    }
  })
  await check('missing quota evidence cannot mark a successful-looking response complete', async () => {
    fixture(); const h = harness()
    await assert.rejects(api.executeSwarmStudio({ ...h.options, handlers: { doc: async (_req, res) => { api.excludeSwarmStudioIdentity(); res.json({ blocks: [{ type: 'p', text: 'Unmetered' }] }) } } }), /required Swarm identity\/quota/)
    assert.equal(h.commits(), 0)
  })
  await check('all 17 library routes preserve actual response shapes and tagged context', async () => {
    const examples = [
      ['website','design',{html:'<main>Website</main>',quality:{runtime:{status:'passed'}}}], ['logo','design',{mark:'<svg/>',lockup:'<svg/>'}],
      ['palette','design',{colors:[{hex:'#334455'}]}], ['brand','design',{html:'<main>Brand book</main>'}],
      ['blueprint','design',{shapes:[{type:'rect'}]}], ['blueprint','design',{floors:[{rooms:[]}]}],
      ['motion','design',{html:'<main>Motion</main>',motion:{duration:5}}], ['game','design',{html:'<canvas></canvas>'}],
      ['poster','design',{html:'<main>Poster</main>'}], ['carousel','design',{slides:[{headline:'First'}],theme:{bg:'#000'}}],
      ['canvas','design',{canvas:{objects:[{type:'text'}]}}], ['shopping','design',{items:[{name:'Chair'}]}],
      ['document','doc',{blocks:[{type:'p',text:'Document'}]}], ['slides','slides',{slides:[{title:'First'}]}],
      ['spreadsheet','sheet',{sheets:[{name:'Budget',columns:['Item'],rows:[['A']]}]}],
      ['image','image',{url:'data:image/png;base64,AAAA'}], ['video','video',{url:'https://provider.invalid/clip.mp4'}],
    ]
    for (const [kind, endpoint, payload] of examples) {
      fixture(); const h = harness(kind); let requestBody
      const handler = mockHandler(payload, endpoint, kind !== 'logo' && !['image','video'].includes(kind))
      const result = await api.executeSwarmStudio({ ...h.options, handlers: { [endpoint]: async (req,res) => { requestBody = req.body; return handler(req,res) } }, prepareArtifact: async (_scope, artifact) => artifact })
      assert.deepEqual(result.payload, payload); assert.equal(h.commits(), 1)
      const requestText = JSON.stringify(requestBody)
      assert.match(requestText, /PROJECT_BRIEF/); assert.match(requestText, /APPROVED_CONTEXT/)
      assert.doesNotMatch(requestText, /UNRELATED_PRIVATE_CONVERSATION/)
      assert.equal(requestBody.brand, undefined); assert.equal(requestBody.prevHtml, undefined); assert.equal(requestBody.token, undefined)
      if (endpoint === 'design') assert.equal(requestBody.kind, kind === 'website' ? 'webpage' : kind)
    }
  })
  await check('large image context and missing durable media store fail before generation', async () => {
    fixture(); const h = harness('image'); let called = false
    await assert.rejects(api.executeSwarmStudio({ ...h.options, handlers: { image: () => { called = true } } }), /durable task-specific media/)
    const read = h.options.store.read; h.options.store.read = async owner => { const value = await read(owner); value.state.projects[0].brief = 'x'.repeat(7000); return value }
    await assert.rejects(api.executeSwarmStudio({ ...h.options, handlers: { image: () => { called = true } }, prepareArtifact: async (_,value) => value }), /no context was silently discarded/)
    assert.equal(called, false)
  })
  await check('generation errors and invalid output refund receipts and save nothing', async () => {
    for (const payload of [{error:'Provider failed'}, {}, {quality:{runtime:{status:'failed'}},html:'<main>Broken</main>'}]) {
      const f = fixture(), h = harness('website')
      await assert.rejects(api.executeSwarmStudio({ ...h.options, handlers: { design: mockHandler(payload) } }))
      assert.equal(h.commits(), 0); assert.equal(f.releases.length, 1)
    }
  })
  await check('durable cancellation after generation wins over late results and refunds quota', async () => {
    const f = fixture(), h = harness(), gate = deferred(); let started = false
    const work = api.executeSwarmStudio({ ...h.options, handlers: { doc: async (_req,res) => {
      api.excludeSwarmStudioIdentity(); await f.reserve('doc','owner-a'); started = true; await gate.promise; res.json({blocks:[{type:'p',text:'Late'}]})
    } } })
    await until(() => started); h.cancel(); gate.resolve()
    await assert.rejects(work, /stopped or changed/); assert.equal(h.commits(), 0); assert.equal(f.releases.length, 1)
  })
  await check('concurrent tasks keep identity, context, quotas, and cancellation separate', async () => {
    const f = fixture(), a = harness('document','owner-a','Rocky'), b = harness('document','owner-b','Milo'), ctrl = new AbortController()
    const entered = [], gates = { 'owner-a': deferred(), 'owner-b': deferred() }
    const handler = async (req,res) => {
      const owner = api.swarmStudioInvocation().ownerId; api.excludeSwarmStudioIdentity(); await f.reserve('doc',owner)
      const signal = api.cancellationSignal(); assert.ok(signal && !signal.aborted); entered.push({owner,signal})
      await gates[owner].promise
      assert.equal(api.swarmStudioInvocation().ownerId, owner)
      assert.match(JSON.stringify(req.body), new RegExp(`${owner}:APPROVED_CONTEXT`))
      assert.doesNotMatch(JSON.stringify(req.body), new RegExp(`${owner === 'owner-a' ? 'owner-b' : 'owner-a'}:APPROVED_CONTEXT`))
      res.json({blocks:[{type:'p',text:owner}]})
    }
    const first = api.executeSwarmStudio({...a.options,handlers:{doc:handler},signal:ctrl.signal}), rejection = assert.rejects(first,{name:'AbortError'})
    const second = api.executeSwarmStudio({...b.options,handlers:{doc:handler}})
    await until(() => entered.length === 2); ctrl.abort(); await rejection
    assert.equal(entered.find(x=>x.owner==='owner-a').signal.aborted,true)
    assert.equal(entered.find(x=>x.owner==='owner-b').signal.aborted,false)
    gates['owner-b'].resolve(); await second; gates['owner-a'].resolve(); await new Promise(resolve=>setImmediate(resolve))
    assert.equal(a.commits(),0); assert.equal(b.commits(),1)
    assert.deepEqual(f.releases.map(x=>x.owner),['owner-a']); assert.equal(getEventListeners(ctrl.signal,'abort').length,0)
    assert.equal(api.swarmStudioInvocation(),undefined)
  })
  await check('asset-save cancellation is fenced and CAD remains waiting for actual compilation', async () => {
    fixture(); const h = harness('cad')
    const result = await api.executeSwarmStudio({...h.options,handlers:{cad:mockHandler({code:'cube([10,10,10]);'},'cad',false)}})
    assert.equal(result.status,'waiting'); assert.match(result.summary,/compile and verify/)
    const f = fixture(), media = harness('image')
    await assert.rejects(api.executeSwarmStudio({...media.options,handlers:{image:mockHandler({url:'data:image/png;base64,AAAA'},'image',false)}, prepareArtifact:async(_scope,value)=>{media.cancel();return value}}),{name:'AbortError'})
    assert.equal(media.commits(),0); assert.equal(f.releases.length,1)
  })
  await check('explicitly truncated HTML stays a saved waiting draft, never a completed artifact', async () => {
    for (const kind of ['poster','game','website']) {
      fixture(); const h = harness(kind), payload = { html:'<html><body><main>Partial draft</main></body></html>', truncated:true }
      const result = await api.executeSwarmStudio({...h.options,handlers:{design:mockHandler(payload)}})
      assert.equal(result.status,'waiting'); assert.match(result.summary,/unfinished draft/)
      assert.match(result.summary,/completion has not been verified/)
      assert.equal(h.saved().jobs[1].status,'waiting'); assert.equal(h.saved().state.tasks[0].status,'waiting')
      assert.deepEqual(h.saved().jobs[1].artifact.payload,payload,'retain actual draft content for review')
    }
    assert.equal(api.validateSwarmStudioArtifact('poster',{html:'<html><body>Complete</body></html>'}).status,'done')
  })
  await check('known precommit rejection refunds instead of claiming an uncertain save', async () => {
    const f = fixture(), h = harness()
    h.options.persist = () => { throw new Error('Artifact exceeds the persistence limit') }
    await assert.rejects(api.executeSwarmStudio({...h.options,handlers:{doc:mockHandler({blocks:[{type:'p',text:'Too large'}]},'doc')}}), error => /persistence limit/.test(error.message) && !error.swarmCommitUncertain)
    assert.equal(h.commits(),0); assert.equal(h.saved().jobs[1].status,'running'); assert.equal(f.releases.length,1)
  })
  await check('uncertain durable commit does not refund or repeat generation', async () => {
    const f = fixture(), h = harness(); const commit = h.options.store.mutateLeased
    h.options.store.mutateLeased = async (...args) => { await commit(...args); throw new Error('Lost commit acknowledgement') }
    await assert.rejects(api.executeSwarmStudio({...h.options,handlers:{doc:mockHandler({blocks:[{type:'p',text:'Saved'}]},'doc')}}), error => error.swarmCommitUncertain === true)
    assert.equal(h.commits(),1); assert.equal(h.saved().jobs[1].status,'done'); assert.equal(f.reservations.length,1); assert.equal(f.releases.length,0)
  })
  await check('book orchestration and unmetered email are never claimed complete', async () => {
    fixture(); const book = harness('book'); let called = false
    await assert.rejects(api.executeSwarmStudio({...book.options,handlers:{doc:()=>{called=true}}}),/outline\/section coordinator/)
    assert.equal(called,false)
    const email = harness('email')
    await assert.rejects(api.executeSwarmStudio({...email.options,handlers:{email:async(_req,res)=>{api.excludeSwarmStudioIdentity();res.json({subject:'Draft',body:'Not sent'})}}}),/required Swarm identity\/quota/)
    assert.equal(email.commits(),0)
  })
  console.log(`${count} Swarm Studio adapter regression groups passed.`)
} finally { globalThis.fetch = originalFetch }
