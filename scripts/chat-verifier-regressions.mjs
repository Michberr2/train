// Actual signed-in chat handler, with deterministic draft/reviewer/research
// fixtures. No provider, account or profile writes. --reproduce uses old behavior.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { readChatStream } from '../client/src/components/workspace/chatStream.ts'
process.env.TINKER_API_KEY = 'offline-verifier-fixture'
const mocks = {
  './_accountContext': 'export async function accountContextForUser() { return \"\" }',
  './web': 'export const research=async()=>globalThis.__verifier.research',
  './_db': `export const identityForRequest=async()=>({id:'synthetic',displayName:'Synthetic',profile:'SYNTHETIC_PROFILE'});
    export const identityBlock=()=> '\\nKnown user data: SYNTHETIC_PROFILE';export const saveProfile=async()=>{throw new Error('No profile writes')};`,
  './_limits': 'export const reserveDailyQuota=async()=>({ok:true,release:async()=>{}})',
  './_llm': `export const repairByteLevelBpe=s=>s; export const makeStreamingBpeRepair=()=>s=>s;
    export const fallbackProvider=()=>null;export const emergencyProvider=()=>null;
    export const chatComplete=async(messages,options)=>{globalThis.__verifier.calls.push({messages,options});return globalThis.__verifier.review(messages)};`,
}
const compiled = await build({ entryPoints: ['api/chat.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'verifier-fixture', setup(build) {
  build.onResolve({ filter: /^\.\/(web|_db|_limits|_llm|_accountContext)$/ }, ({ path }) => ({ path, namespace: 'fixture' }))
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }))
} }] })
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const stream = text => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } })
const savedFetch = globalThis.fetch
async function run(answer, body, review = () => 'OK', research = null) {
  globalThis.__verifier = { calls: [], review, research }
  let providerCalls = 0, wire = ''
  globalThis.fetch = async () => {
    assert.equal(++providerCalls, 1, 'no hidden provider retries')
    return new Response(stream(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`), { headers: { 'content-type': 'text/event-stream' } })
  }
  const req = new EventEmitter(); req.method = 'POST'; req.headers = { authorization: 'Bearer isolated-owner' }
  req.body = { specialist: 'math', webSearch: false, ...body }
  const res = new EventEmitter(); res.writableEnded = false
  res.setHeader = () => {}; res.flushHeaders = () => {}; res.write = text => { wire += text; return true }
  res.status = () => res; res.json = value => { throw new Error('Unexpected JSON ' + JSON.stringify(value)) }
  res.end = () => { res.writableEnded = true; res.emit('finish') }
  await handler(req, res)
  assert.equal(res.writableEnded, true)
  const result = await readChatStream(stream(wire), {})
  assert.equal(result.error, undefined)
  return { ...result, calls: globalThis.__verifier.calls }
}
try {
  const earlier = 'SOURCE_PREMISE: In this fictional exercise one pack contains exactly7 units. The order has3 packs. Use that supplied premise.'
  const answer = 'The order contains21 units because its three packs each contain the supplied seven units. Multiplying3 by7 gives21, with no extra units added.'
  const body = { messages: [{ role: 'user', content: earlier }, { role: 'assistant', content: 'Understood:7 units per pack.' }, { role: 'user', content: 'Explain the total using the supplied pack size.' }] }
  const grounded = await run(answer, body, messages => JSON.stringify(messages).includes('SOURCE_PREMISE') ? 'OK' : 'FIX: The7-unit pack size is unsupported and should be replaced with a standard12-unit pack.')
  if (process.argv.includes('--reproduce')) {
    assert.equal(grounded.calls.length, 1)
    assert.doesNotMatch(JSON.stringify(grounded.calls[0].messages), /SOURCE_PREMISE/)
    assert.match(grounded.text, /On review — a correction/)
    console.log('REPRODUCED actual handler: verifier receives no earlier supplied premise and appends a false correction to the correct answer')
  } else {
    let groups = 0
    assert.equal(grounded.calls.length, 1)
    assert.match(JSON.stringify(grounded.calls[0].messages), /SOURCE_PREMISE/)
    assert.equal(grounded.text, answer)
    const initial = JSON.parse(grounded.calls[0].messages[1].content)
    assert.deepEqual(initial.conversation, body.messages)
    assert.equal(initial.answerToCheck, answer)
    assert.equal(grounded.calls[0].options.timeoutMs, 12000)
    assert.equal(grounded.calls[0].options.maxAttempts, 1)
    assert.equal(grounded.calls[0].options.retryPrimary, false)
    assert.ok(grounded.calls[0].options.signal instanceof AbortSignal)
    assert.match(grounded.calls[0].messages[0].content, /fictional or self-contained/)
    assert.match(grounded.calls[0].messages[0].content, /no tools in this review/)
    groups++

    const evidence = { text: 'VERIFIED_RESEARCH: The dated synthetic program has a cap of37 units for this fictional reporting period. https://example.invalid/dated-program', sources: [{ url: 'https://example.invalid/dated-program', title: 'Dated synthetic program' }] }
    const researchedAnswer = 'The synthetic program has a cap of37 units for the stated reporting period, as the dated source specifies. https://example.invalid/dated-program'
    const researched = await run(researchedAnswer, {
      specialist: 'finance', webSearch: true, systemPrompt: 'Use supplied dated facts for the synthetic program.', memory: 'The program is named Cedar.',
      messages: [{ role: 'user', content: 'Explain the current cap on the synthetic program and cite the dated evidence.' }],
    }, messages => JSON.stringify(messages).includes('VERIFIED_RESEARCH') ? 'OK' : 'FIX: The cap should be a different number from memory.', evidence)
    assert.equal(researched.text, researchedAnswer)
    assert.equal(researched.calls.length, 1)
    const record = JSON.parse(researched.calls[0].messages[1].content)
    assert.equal(record.research, evidence.text); assert.deepEqual(record.sources, evidence.sources)
    assert.equal(record.conversationInstructions, 'Use supplied dated facts for the synthetic program.')
    assert.equal(record.crossChatMemory, 'The program is named Cedar.')
    assert.match(record.userBackground, /SYNTHETIC_PROFILE/)
    groups++

    const toolHistory = [{ role: 'user', content: 'Use the synthetic reading to calculate the resulting count and explain the result.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'source-read', type: 'function', function: { name: 'lookup_sample', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'source-read', content: 'OBSERVED_TOOL_RESULT: Each of3 bins contains7 parts.' }]
    const fromTool = await run(answer, { messages: toolHistory })
    assert.equal(fromTool.calls.length, 1)
    assert.deepEqual(JSON.parse(fromTool.calls[0].messages[1].content).conversation, toolHistory, 'native call/result identity and all supplied evidence reach the verifier')
    groups++

    const incorrect = 'The total is22 units. Three packs are being combined, with seven units in each pack, so this total counts the complete contents of all three packs.'
    const corrected = await run(incorrect, body, messages => {
      const record = JSON.parse(messages[1].content)
      assert.equal(record.answerToCheck, incorrect)
      assert.match(JSON.stringify(record.conversation), /SOURCE_PREMISE/)
      return 'FIX: Three packs of7 units total21 units, because3×7=21;22 was an arithmetic error.'
    })
    assert.match(corrected.text, /On review — a correction/)
    assert.match(corrected.text, /total21 units/)
    assert.equal(corrected.calls.length, 1)
    groups++

    const json = JSON.stringify({ project: 'Cedar', total: 21, description: 'Three synthetic packs contain seven units each; the supplied facts determine the result.' })
    const code = '```python\n# Count the complete contents of the supplied synthetic packs.\nunits_per_pack = 7\npack_count = 3\ntotal_units = units_per_pack * pack_count\n```'
    for (const [output, requestText] of [[json, 'Return only a JSON object with project, total and description.'], [json, 'Calculate the supplied total.'], [code, 'Return only the Python code.'], [answer, 'Use exactly two sentences and no extra explanation.'], [answer, 'Answer in 100 words.'], [answer, 'Use 200 characters.']]) {
      const exact = await run(output, { messages: [body.messages[0], { role: 'user', content: requestText }] }, () => 'FIX: This appendix would break the user output contract.')
      assert.equal(exact.text, output)
      assert.equal(exact.calls.length, 0, 'skip optional append-only review when it cannot safely deliver a correction')
    }
    const exactFromInstructions = await run(answer, { ...body, systemPrompt: 'Respond with exactly two sentences.' }, () => 'FIX: Unrequested appendix.')
    assert.equal(exactFromInstructions.text, answer); assert.equal(exactFromInstructions.calls.length, 0)
    groups++

    const researchJson = await run(json, { specialist: 'finance', webSearch: true, messages: [{ role: 'user', content: 'Use current synthetic program research. Return only JSON with project, total and description.' }] }, () => 'FIX: Unrequested prose.', evidence)
    assert.deepEqual(JSON.parse(researchJson.text), JSON.parse(json), 'canonical Sources footer must not corrupt researched JSON')
    assert.equal(researchJson.calls.length, 0)
    assert.equal(researchJson.autoResearch, true)
    groups++

    const structured = [
      ['CSV', 'project,total,description\nCedar,21,Three synthetic packs contain seven units each and the supplied facts determine the result.'],
      ['TSV', 'project\ttotal\tdescription\nCedar\t21\tThree synthetic packs contain seven units each and the supplied facts determine the result.'],
      ['YAML', 'project: Cedar\ntotal: 21\ndescription: Three synthetic packs contain seven units each and the supplied facts determine the result.'],
      ['SQL', "SELECT 'Cedar' AS project, 21 AS total, 'Three synthetic packs contain seven units each and the supplied facts determine the result.' AS description;"],
    ]
    for (const [format, output] of structured) {
      const requests = [
        `Return the results as ${format}.`,
        ...['Return', 'Output', 'Write', 'Provide', 'Generate', 'Produce', 'Format'].map(verb => `${verb} valid ${format}.`),
        `The required representation is ${format} format.`,
      ]
      for (const request of requests) {
        const exact = await run(output, { specialist: 'finance', webSearch: true, messages: [{ role: 'user', content: `Use current synthetic program research. ${request}` }] }, () => 'FIX: This prose would corrupt the requested format.', evidence)
        assert.equal(exact.autoResearch, true)
        assert.equal(exact.text, output, `Sources footer and corrections must not corrupt "${request}" without an explicit "only"`)
        assert.equal(exact.calls.length, 0)
      }
    }
    groups++

    const completeTail = answer + '\n' + 'Additional supplied calculation detail. '.repeat(180) + '\nANSWER_TAIL_MUST_REMAIN'
    const completeReview = await run(completeTail, body)
    assert.equal(completeReview.calls.length, 1)
    assert.equal(JSON.parse(completeReview.calls[0].messages[1].content).answerToCheck, completeTail, 'do not review a silently clipped answer')
    const long = await run(answer, { messages: [{ role: 'user', content: 'Complete supplied record: ' + 'Original evidence. '.repeat(3000) }, ...body.messages] }, () => 'FIX: A clipped-record guess.')
    assert.equal(long.calls.length, 0, 'oversized evidence skips optional review instead of reviewing an incomplete record')
    assert.equal(long.text, answer)
    groups++

    const uncertainty = await run(answer, body, () => 'Possibly wrong, but evidence is incomplete.')
    assert.equal(uncertainty.text, answer)
    const generalCalculation = await run(answer, {
      specialist: 'general',
      messages: [{ role: 'user', content: 'Calculate the supplied total from the earlier fictional pack-size premise and explain the arithmetic.' }],
    }, messages => {
      assert.match(JSON.stringify(messages), /answerToCheck/)
      return 'OK'
    })
    assert.equal(generalCalculation.calls.length, 1, 'general calculation prompts receive the bounded verifier too')
    assert.equal(generalCalculation.text, answer)
    console.log(`PASS ${groups} actual signed-in verifier groups: original premises, dated research, user context, native tool evidence, supported correction, exact JSON/CSV/TSV/YAML/SQL/code/length, and complete bounded review`)
  }
} finally { globalThis.fetch = savedFetch; delete globalThis.__verifier }
