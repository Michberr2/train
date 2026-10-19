// Actual voice handlers + cancellation + SSE parsing; fake HTTP/provider/runtime
// boundaries only. No credentials, live inference, microphone or paid calls.
import assert from 'node:assert/strict'
import {EventEmitter, getEventListeners} from 'node:events'
import {build} from 'esbuild'
const names = ['FISH_API_KEY','OPENAI_API_KEY','ELEVENLABS_API_KEY','GROQ_API_KEY','TINKER_API_KEY','HUGGINGFACE_API_TOKEN','HF_TOKEN','NALU_TTS_VOICE','NALU_ELEVEN_VOICE','NALU_ELEVEN_VOICE_BRITISH_MAN','NALU_ELEVEN_VOICE_BRITISH_WOMAN']
const originalEnv = Object.fromEntries(names.map(name=>[name,process.env[name]])), originalFetch = globalThis.fetch
globalThis.__voiceQuota = {denied: false,unavailable:false,reserved:0,refunded:0}
const built = await build({stdin:{contents:"export {default as tts, providerVoice} from './api/tts'; export {default as transcribe, decodeRecording} from './api/transcribe'; export * from './api/_voiceProvider';",loader:'ts',resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'runtime-wait',setup(b){b.onResolve({filter:/^\.\/_limits$/},()=>({path:'limits',namespace:'quota-fixture'}));b.onLoad({filter:/.*/,namespace:'quota-fixture'},()=>({contents:`export async function reserveDailyQuota(){const q=globalThis.__voiceQuota;q.reserved++;return {ok:!q.denied&&!q.unavailable,status:q.unavailable?503:429,release:async()=>{q.refunded++}}};export function studioLimitMessage(){return 'Voice allowance unavailable.'}`,loader:'js'}));b.onResolve({filter:/^@vercel\/functions$/},()=>({path:'wait',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const waitUntil=promise=>{void promise.catch(()=>{})}',loader:'js'}))}}]})
const server = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const mp3 = Buffer.concat([Buffer.from('ID3'),Buffer.alloc(2048,1)])
const audio = () => new Response(mp3,{headers:{'Content-Type':'audio/mpeg'}})
const no = status => new Response('private-key-secret-and-upstream-debug',{status})
const json = data => Response.json(data)
let count=0, requests=[]
function env(values={}) {for(const name of names) delete process.env[name]; Object.assign(process.env,values)}
function transport(fn) {requests=[];globalThis.fetch=async(url,init)=>{requests.push({url:String(url),init});return fn(String(url),init)}}
function objects(body,extra={}) {
  const req=Object.assign(new EventEmitter(),{method:'POST',body,headers:{},...extra})
  const res=Object.assign(new EventEmitter(),{code:null,body:undefined,headers:{},writableEnded:false,destroyed:false,status(code){this.code=code;return this},setHeader(name,value){this.headers[name.toLowerCase()]=value},json(value){this.setHeader('Content-Type','application/json');this.body=value;this.writableEnded=true;return this},send(value){this.body=value;this.writableEnded=true;return this},end(){this.writableEnded=true}})
  return {req,res}
}
async function invoke(handler,body,extra) {const pair=objects(body,extra);await handler(pair.req,pair.res);assert.equal(pair.req.listenerCount('aborted'),0);assert.equal(pair.res.listenerCount('close'),0);return pair.res}
async function check(name,fn){await fn();count++;console.log(`PASS ${name}`)}
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve()}
try {
  await check('Voice quota denial/outage starts no providers; failures refund reservations',async()=>{
    env({FISH_API_KEY:'fixture',TINKER_API_KEY:'fixture'});transport(()=>no(503))
    for(const handler of [server.tts,server.transcribe]){
      const body=handler===server.tts?{text:'hello'}:{audio:Buffer.from('recording').toString('base64'),mime:'audio/wav'}
      for(const key of ['denied','unavailable']){globalThis.__voiceQuota[key]=true;const result=await invoke(handler,body);assert.equal(result.code,key==='denied'?429:503);assert.equal(requests.length,0);globalThis.__voiceQuota[key]=false}
      const before=globalThis.__voiceQuota.refunded;const failed=await invoke(handler,body);assert.equal(failed.code,502);assert.equal(globalThis.__voiceQuota.refunded,before+1);requests=[]
    }
  })
  await check('Fish HTTP failure falls back to OpenAI with provider alias and stable timed JSON',async()=>{
    env({FISH_API_KEY:'fixture',OPENAI_API_KEY:'fixture'});transport(url=>url.includes('fish.audio')?no(503):audio())
    const result=await invoke(server.tts,{text:'Hello there.',voice:'britishWoman',timestamps:true})
    assert.equal(result.code,200);assert.deepEqual(result.body.segments,[]);assert.deepEqual(Buffer.from(result.body.audioBase64,'base64'),mp3)
    assert.equal(requests.length,2);assert.equal(JSON.parse(requests[1].init.body).voice,'nova')
    assert.equal(result.headers['content-type'],'application/json')
  })
  await check('Fish network and OpenAI failure reach Eleven with a real mapped voice ID',async()=>{
    env({FISH_API_KEY:'fixture',OPENAI_API_KEY:'fixture',ELEVENLABS_API_KEY:'fixture'});transport(url=>{if(url.includes('fish.audio'))throw Error('secret upstream');return url.includes('openai')?no(429):audio()})
    const result=await invoke(server.tts,{text:'Hello.',voice:'britishMan'})
    assert.equal(result.code,200);assert.deepEqual(result.body,mp3);assert.equal(requests.length,3)
    assert.ok(requests[2].url.endsWith('/JBFqnCBsd6RMkjVDRZzb'));assert.equal(JSON.parse(requests[1].init.body).voice,'onyx')
  })
  await check('Fish timed audio retains real alignment and replaces duplicate snapshots',async()=>{
    env({FISH_API_KEY:'fixture'})
    const events=[{audio_base64:mp3.toString('base64'),chunk_seq:0,chunk_audio_offset_sec:0,alignment:{segments:[{text:'Hello',start:0,end:0.2}]}},{chunk_seq:0,chunk_audio_offset_sec:0,alignment:{segments:[{text:'Hello',start:0,end:0.4}]}}]
    transport(()=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}))
    const result=await invoke(server.tts,{text:'Hello',timestamps:true})
    assert.equal(result.code,200);assert.deepEqual(result.body.segments,[{text:'Hello',start:0,end:0.4}]);assert.equal(requests.length,1)
  })
  await check('Corrupt partial timed output is discarded before fallback',async()=>{
    env({FISH_API_KEY:'fixture',OPENAI_API_KEY:'fixture'});transport(url=>url.includes('fish')?new Response('data: '+JSON.stringify({audio_base64:mp3.toString('base64')})+'\n\ndata: {broken}\n\n'):audio())
    const result=await invoke(server.tts,{text:'Hello',timestamps:true})
    assert.equal(result.code,200);assert.deepEqual(Buffer.from(result.body.audioBase64,'base64'),mp3);assert.deepEqual(result.body.segments,[])
  })
  await check('No configured provider and exhausted providers return sanitized errors',async()=>{
    env();transport(()=>assert.fail('no provider should be called'));assert.equal((await invoke(server.tts,{text:'Hello'})).code,501)
    env({FISH_API_KEY:'fixture',OPENAI_API_KEY:'fixture'});transport(()=>no(500));const result=await invoke(server.tts,{text:'Hello'})
    assert.equal(result.code,502);assert.ok(!JSON.stringify(result.body).includes('private'));assert.equal(requests.length,2)
  })
  await check('Speech input size/type validation happens before provider I/O',async()=>{
    env({FISH_API_KEY:'fixture'});transport(()=>assert.fail('invalid input contacted a provider'))
    for(const [body,code] of [[{text:'x'.repeat(1601)},413],[{text:{}},400],['{',400]])assert.equal((await invoke(server.tts,body)).code,code)
  })
  await check('Oversized advertised provider output falls back without buffering it',async()=>{
    env({FISH_API_KEY:'fixture',OPENAI_API_KEY:'fixture'});transport(url=>url.includes('fish')?new Response(mp3,{headers:{'content-length':String(99*1024*1024)}}):audio())
    assert.equal((await invoke(server.tts,{text:'Hello'})).code,200);assert.equal(requests.length,2)
  })
  await check('Voice deadline settles ignored transport aborts and removes caller listeners',async()=>{
    const controller=new AbortController();let upstream
    await assert.rejects(server.withVoiceDeadline(controller.signal,5,signal=>{upstream=signal;return new Promise(()=>{})}),{name:'AbortError'})
    assert.equal(upstream.aborted,true);assert.equal(controller.signal.aborted,false);assert.equal(getEventListeners(controller.signal,'abort').length,0)
  })
  await check('Bounded response reading rejects a large streamed chunk and cancels its source',async()=>{
    let cancelled=false;const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(11))},cancel(){cancelled=true}}))
    await assert.rejects(server.readVoiceBytes(response,10,new AbortController().signal),/exceeded/);assert.equal(cancelled,true)
  })
  await check('Caller cancellation aborts TTS without trying another provider or replying',async()=>{
    env({FISH_API_KEY:'fixture',OPENAI_API_KEY:'fixture'});let upstream
    transport((_url,init)=>{upstream=init.signal;return new Promise(()=>{})})
    const caller=new AbortController(),pair=objects({text:'Hello'},{signal:caller.signal})
    const pending=server.tts(pair.req,pair.res);await flush();caller.abort();await pending
    assert.equal(upstream.aborted,true);assert.equal(requests.length,1);assert.equal(pair.res.code,null);assert.equal(getEventListeners(caller.signal,'abort').length,0)
  })
  await check('Silent primary transcription is valid empty text and never triggers another provider',async()=>{
    env({TINKER_API_KEY:'fixture',OPENAI_API_KEY:'fixture'});transport(()=>json({choices:[{finish_reason:'stop',message:{content:''}}]}))
    const result=await invoke(server.transcribe,{audio:mp3.toString('base64'),mime:'audio/mpeg'})
    assert.equal(result.code,200);assert.deepEqual(result.body,{text:'',engine:'inkling'});assert.equal(requests.length,1)
  })
  await check('Incomplete primary output and Groq failure reach OpenAI transcription',async()=>{
    env({TINKER_API_KEY:'fixture',GROQ_API_KEY:'fixture',OPENAI_API_KEY:'fixture'})
    transport((url)=>requests.length===1?json({choices:[{finish_reason:'length',message:{content:'truncated'}}]}):requests.length===2?no(400):url.includes('groq')?no(503):json({text:'A complete transcription.'}))
    const result=await invoke(server.transcribe,{audio:`data:audio/webm;codecs=opus;base64,${mp3.toString('base64')}`})
    assert.equal(result.code,200);assert.equal(result.body.text,'A complete transcription.');assert.equal(requests.length,4)
    assert.equal(requests[3].init.body.get('model'),'whisper-1');assert.equal(requests[3].init.body.get('file').size,mp3.length)
  })
  await check('HF silence and input base64 validation preserve the public text contract',async()=>{
    env({HF_TOKEN:'fixture'});transport(()=>json({text:''}))
    assert.equal((await invoke(server.transcribe,{audio:mp3.toString('base64'),mime:'audio/mp3'})).body.text,'')
    transport(()=>assert.fail('invalid recording contacted provider'))
    for(const [body,code] of [[{audio:'%%%bad'},400],[{audio:'YQ',mime:'text/plain'},415],[{audio:'A'.repeat(4*1024*1024+257)},413],[{audio:'YQ===',mime:'audio/mpeg'},400]])assert.equal((await invoke(server.transcribe,body)).code,code)
  })
  await check('Transcription output bounds reject oversized JSON without exposing provider diagnostics',async()=>{
    env({OPENAI_API_KEY:'fixture'});transport(()=>new Response('private debugging',{headers:{'content-length':String(1024*1024)}}))
    const result=await invoke(server.transcribe,{audio:mp3.toString('base64'),mime:'audio/mpeg'})
    assert.equal(result.code,502);assert.equal(result.body.inkling,undefined);assert.ok(!JSON.stringify(result.body).includes('debugging'))
  })
  await check('Transcription request cancellation aborts upstream and never triggers fallback',async()=>{
    env({TINKER_API_KEY:'fixture',GROQ_API_KEY:'fixture'});let upstream
    transport((_url,init)=>{upstream=init.signal;return new Promise(()=>{})})
    const caller=new AbortController(),pair=objects({audio:mp3.toString('base64'),mime:'audio/mpeg'},{signal:caller.signal})
    const pending=server.transcribe(pair.req,pair.res);await flush();caller.abort();await pending
    assert.equal(upstream.aborted,true);assert.equal(requests.length,1);assert.equal(pair.res.code,null)
  })
  console.log(`${count} voice provider regressions passed. No live audio/provider calls.`)
} finally {
  globalThis.fetch=originalFetch
  for(const [name,value] of Object.entries(originalEnv))if(value===undefined)delete process.env[name];else process.env[name]=value
}
