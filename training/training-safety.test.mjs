import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {contentHash, reviewDataset, rowEligibility, loadReviewedDataset} from './dataset-policy.mjs'
import {deployWithRollback, resolveIncumbent, gradeDomainAnswer, validateDomainBattery, evaluateDomainGate} from './promotion-gate.mjs'
import {samplerFromTrainingResult} from './training-result.mjs'
import {parseChatProbe, verifyProbeRouting} from './fleet-verification.mjs'
import {acquireRunLock} from './flywheel.mjs'

function reviewedRow(prompt = 'A reviewed synthetic task', split = 'train') {
  const row = {system: 'Answer accurately', user: prompt, assistant: 'A checked answer'}
  row.training = {schemaVersion: 1, contentSha256: contentHash(row), source: {kind: 'synthetic', id: 'fixture', version: '1', teacher: 'teacher-fixture'}, consent: {remoteTraining: true, recordId: 'fixture-license'}, review: {redaction: 'passed', quality: 'passed', reviewer: 'independent-test', evidence: 'fixture-assertion'}, surface: 'web', domain: 'math', split}
  return row
}
test('dataset policy rejects missing/forged review, secrets and revoked consent without changing data', () => {
  const row = reviewedRow()
  assert.deepEqual(rowEligibility(row), [])
  assert.ok(rowEligibility({...row, training: undefined}).length)
  assert.ok(rowEligibility({...row, assistant: 'modified'}).includes('content changed after review'))
  assert.ok(rowEligibility(row, {...row.training, consent: {...row.training.consent, revoked: true}}).length)
  assert.ok(rowEligibility(row, {...row.training, review: {...row.training.review, reviewer: 'teacher-fixture'}}).length)
  const secret = reviewedRow('api_key=tml-' + 'a'.repeat(24)); assert.ok(rowEligibility(secret).includes('potential secret requires redaction'))
  const before = JSON.stringify(row); reviewDataset([row]); assert.equal(JSON.stringify(row), before)
})
test('training/holdout duplicates normalize case and whitespace', () => {
  const result = reviewDataset([reviewedRow('A task'), reviewedRow('  A   TASK  ', 'test')])
  assert.equal(result.rejected.length, 1); assert.ok(result.rejected[0].reasons.includes('prompt overlaps data splits'))
})
test('legacy sidecar must match exact dataset bytes; audit never grants approval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalu-data-policy-'))
  try {
    const file = path.join(dir, 'data.jsonl'); fs.writeFileSync(file, JSON.stringify({user: 'fixture', assistant: 'response'}) + '\n')
    assert.throws(() => loadReviewedDataset(file), /not eligible/)
    assert.equal(loadReviewedDataset(file, {strict: false}).accepted.length, 0)
    fs.writeFileSync(`${file}.review.json`, JSON.stringify({schemaVersion: 1, datasetSha256: 'wrong', rows: {}}))
    assert.throws(() => loadReviewedDataset(file), /does not match/)
  } finally {fs.rmSync(dir, {recursive: true, force: true})}
})
test('production incumbent uses lane override and refuses disabled specialist adapters', () => {
  const env = {NALU_USE_SPECIALIST_LORAS: '1', NALU_MATH_MODEL: 'lane-incumbent', NALU_DEFAULT_MODEL: 'default', TINKER_API_KEY: 'fixture'}
  assert.equal(resolveIncumbent('math', env).model, 'lane-incumbent')
  assert.equal(resolveIncumbent('agent', {...env, NALU_CLI_MODEL: 'cli'}).model, 'cli')
  assert.throws(() => resolveIncumbent('math', {...env, NALU_USE_SPECIALIST_LORAS: '0'}), /disabled/)
})
const domainBattery = () => ({schemaVersion: 1, lane: 'math', surface: 'web', split: 'test', provenance: {reviewer: 'independent', source: 'fixture', version: '1'}, cases: Array.from({length: 20}, (_, i) => ({id: String(i), prompt: `Compute fixture ${i}`, system: 'Return JSON', category: `category-${i % 3}`, critical: true, grader: {type: 'json-exact', expected: {answer: i}}}))})
test('domain battery requires independent holdout ground truth and categories, not CLI format', () => {
  const battery = domainBattery()
  assert.equal(validateDomainBattery(battery, 'math', []).length, 64)
  assert.throws(() => validateDomainBattery({...battery, lane: 'legal'}, 'math', []), /lane-specific/)
  assert.throws(() => validateDomainBattery(battery, 'math', [{user: battery.cases[0].prompt}]), /contaminated/)
  assert.equal(gradeDomainAnswer('{"answer":10}', battery.cases[10]), true)
  assert.equal(gradeDomainAnswer('{"answer":100}', battery.cases[10]), false)
  assert.equal(gradeDomainAnswer('Therefore, source says answer is 10', battery.cases[10]), false)
})
test('domain promotion rejects critical regression and provider failure; accepts measured win', async () => {
  const battery = domainBattery(), params = {lane: 'math', candidate: {model: 'candidate'}, incumbent: {model: 'incumbent'}, battery, trainingRows: []}
  const sample = async (model, _system, prompt) => {const i = Number(prompt.split(' ').at(-1)); return JSON.stringify({answer: model.model === 'candidate' || i < 17 ? i : -1})}
  const result = await evaluateDomainGate({...params, sample}); assert.equal(result.qualified, true); assert.equal(result.per.length, 20)
  const bad = await evaluateDomainGate({...params, sample: async () => '{"answer":0}'}); assert.equal(bad.qualified, false)
  await assert.rejects(evaluateDomainGate({...params, sample: async () => null}), /provider failed/)
})
test('deployment failures restore old value after both write and release failures', async () => {
  for (const point of ['write', 'release']) {
    let value = 'incumbent', writes = 0
    await assert.rejects(deployWithRollback({key: 'MODEL', candidate: 'candidate', expected: 'incumbent', read: async () => value, write: async (_key, next) => {value = next; writes++; if (point === 'write' && writes === 1) throw Error('partial write')}, deploy: async () => false}), /restored/)
    assert.equal(value, 'incumbent'); assert.equal(writes, 2)
  }
})
test('rollback restores absent variables and rejects concurrent changes', async () => {
  let value
  await assert.rejects(deployWithRollback({key: 'MODEL', candidate: 'new', expected: undefined, read: async () => value, write: async (_key, next) => {value = next}, deploy: async () => false}), /restored/)
  assert.equal(value, undefined)
  await assert.rejects(deployWithRollback({key: 'MODEL', candidate: 'new', expected: 'old', read: async () => 'concurrent', write: async () => assert.fail('must not write'), deploy: async () => true}), /changed during/)
})
test('trainer result parser ignores checkpoints in diagnostics, failed exits, signals and missing holdout', () => {
  const receipt = {schemaVersion: 1, success: true, saved: true, validation: {completed: true}, datasetSha256: 'a'.repeat(64), modelPath: 'tinker://fixture/sampler_weights/final'}
  const stdout = `diagnostic tinker://old/sampler_weights/intermediate\nNALU_TRAINING_RESULT ${JSON.stringify(receipt)}\n`
  assert.equal(samplerFromTrainingResult({status: 0, stdout}), receipt.modelPath)
  for (const result of [{status: 1, stdout}, {status: 0, signal: 'SIGKILL', stdout}, {status: 0, stdout: 'tinker://fixture/sampler_weights/final'}, {status: 0, stdout: stdout + stdout}]) assert.equal(samplerFromTrainingResult(result), null)
})
test('fleet probes require both correct routes and complete responses', () => {
  const probe = kind => parseChatProbe(`event: route\ndata: {"kind":"${kind}","name":"Nalu"}\n\nevent: text\ndata: {"text":"response"}\n\nevent: done\ndata: {}\n\n`, 200)
  const domain = {kind: 'math', offTopic: 'Unrelated coding task', offTopicKind: 'code'}
  assert.equal(verifyProbeRouting(domain, probe('math'), probe('code')).passed, true)
  assert.equal(verifyProbeRouting(domain, probe('math'), probe('math')).passed, false)
  assert.equal(verifyProbeRouting(domain, {...probe('math'), finished: false}, probe('code')).passed, false)
  assert.equal(probe('math').servingModel, null)
})
test('run lock prevents overlap without guessing from elapsed time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalu-lock-')), file = path.join(dir, 'lock')
  const release = acquireRunLock(file)
  try {assert.throws(() => acquireRunLock(file), /EEXIST/)} finally {release(); fs.rmdirSync(dir)}
})
