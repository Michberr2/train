import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
process.env.TINKER_API_KEY='offline-design-review';
const services = {
'./_db': 'export async function identityForRequest(){globalThis.__review.events.push("identity");return null} export function identityBlock(){return ""}',
'./_limits': 'export async function reserveStudioQuota(){globalThis.__review.events.push("quota");return {ok:globalThis.__review.allow,status:429,release:async()=>{globalThis.__review.events.push("refund")}}} export function studioLimitMessage(){return "limit"}',
'./_grounding': 'export async function groundResearch(){globalThis.__review.events.push("research");return {text:"",sources:[],status:"not-needed"}}',
'./web': 'export async function research(){throw new Error("unexpected research")}',
'./_publicFetch': 'export async function publicFetch(){throw new Error("blocked offline network")}',
'./_studioGeneration': 'export async function generateStudioJson(options){globalThis.__review.events.push("generate");return options.parse(JSON.stringify(globalThis.__review.output))}',
};
const built=await build({entryPoints:['api/design.ts'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',plugins:[{name:'review-fixtures',setup(b){b.onResolve({filter:/^\.\/(?:_db|_limits|_grounding|web|_publicFetch|_studioGeneration)$/},({path})=>({path,namespace:'review'}));b.onLoad({filter:/.*/,namespace:'review'},({path})=>({contents:services[path],loader:'js'}));}}]});
const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const invoke=async(body,output={},allow=true)=>{globalThis.__review={events:[],output,allow};const res={status(s){this.code=s;return this},setHeader(){},json(body){this.body=body;this.writableEnded=true}};await module.exports.default({method:'POST',body,headers:{}},res);return {code:res.code,body:res.body,events:globalThis.__review.events}};
const shapes = [
  {type:'rect',x:10,y:10,w:-5,h:20,label:'BEDROOM'},
  {type:'rect',x:10,y:10,w:0,h:20,label:'BEDROOM'},
  {type:'rect',x:90,y:10,w:20,h:20,label:'BEDROOM'},
  {type:'circle',cx:20,cy:20,r:-3},
  {type:'line',x1:0,y1:0,x2:101,y2:20},
  {type:'ellipse',cx:20,cy:20,rx:4,ry:0},
  {type:'polyline',points:[[0,0],['bad',10]]},
  {type:'door',x:20,y:20,w:3,dir:'h'},
  {type:'door',x:0,y:20,w:3,dir:'h'},
  null,
]
for (const shape of shapes) {
  const response = await invoke({kind:'blueprint',prompt:'Draw a plan'}, {viewBox:{w:100,h:100},shapes:[shape]})
  assert.ok(response.code>=400,`invalid geometry must fail: ${JSON.stringify(shape)}`)
  assert.ok(response.events.includes('refund'))
}
const goodPlan = {viewBox:{w:100,h:100},shapes:[{type:'rect',x:0,y:0,w:20,h:20,label:'BEDROOM'},{type:'door',x:0,y:10,w:3,dir:'v'}]}
assert.equal((await invoke({kind:'blueprint',prompt:'Draw a plan'},goodPlan)).code,200)
// The example shown to the model must satisfy the same geometry contract as
// its output. Missing orientation fields otherwise force avoidable repairs.
const designSource = readFileSync('api/design.ts', 'utf8')
const blueprintLiteral = designSource.match(/const SYSTEM_BLUEPRINT = (`[\s\S]*?`)\n/)
assert.ok(blueprintLiteral, 'canonical blueprint prompt exists')
const blueprintPrompt = new Function('return ' + blueprintLiteral[1])()
const blueprintExample = JSON.parse(blueprintPrompt.slice(blueprintPrompt.indexOf('{"title"'), blueprintPrompt.indexOf('\n\nRules')).trim())
const exampleResponse = await invoke({kind:'blueprint',prompt:'Draw the example plan'}, blueprintExample)
assert.equal(exampleResponse.code, 200, JSON.stringify(exampleResponse.body))
assert.equal(exampleResponse.events.filter(event => event === 'generate').length, 1, 'canonical example needs no repair')
for (const brand of [{},{brand:{}},{brand:{name:'Brand'},palette:[{hex:'#000000'}]}]) {
  const response=await invoke({kind:'brand',prompt:'Create a brand book'},brand)
  assert.equal(response.code,502);assert.ok(response.events.includes('refund'));assert.equal(response.body.html,undefined)
}
const brand={brand:{name:'Harbor',tagline:'Clear thinking',mission:'Help teams explain their work.',vision:'Make complex work understandable.',positioning:'Tools for thoughtful teams.',values:['Clarity','Care','Focus'].map(label=>({label,description:'Write with purpose.'})),voice:['Warm','Direct'].map(label=>({label,description:'Use plain words.'}))},palette:[{role:'primary',name:'Ocean',hex:'#123456',usage:'Headings'},{role:'light',name:'Paper',hex:'#FFFFFF',usage:'Background'},{role:'dark',name:'Ink',hex:'#111111',usage:'Text'}],typography:{heading:{family:'Inter',usage:'Headings'},body:{family:'Jost',usage:'Body'}},logo:{direction:'A simple wordmark',clearspace:'One cap height',minSize:'24 pixels'},dos:['Use space','Write clearly','Keep contrast'],donts:['Stretch marks','Invent claims','Use tiny text']}
const book=await invoke({kind:'brand',prompt:'Create Harbor brand guidelines'},brand)
assert.equal(book.code,200);assert.match(book.body.html,/Harbor/);assert.ok(!book.events.includes('refund'))
const quota=await invoke({kind:'webpage',prompt:'Research the latest market for a website'}, {},false)
assert.equal(quota.code,429);assert.deepEqual(quota.events,['quota'],'denied allowance must precede external research and generation')
console.log('PASS actual design endpoint rejects invalid geometry and empty brand books, refunds failures, accepts valid drawing/content and reserves before external research.')
