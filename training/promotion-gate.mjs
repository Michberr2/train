import {createHash} from 'node:crypto'
import {promptHash} from './dataset-policy.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
export const laneEnvName = lane => lane === 'agent' ? 'NALU_CLI_MODEL' : `NALU_${lane.toUpperCase()}_MODEL`

// Must receive a fresh production environment snapshot, never local flywheel history.
export function resolveIncumbent(lane, env) {
  if (lane !== 'agent' && env.NALU_USE_SPECIALIST_LORAS !== '1') throw new Error('Specialist adapters are disabled in production; domain promotion is unavailable')
  const model = env[laneEnvName(lane)] || env.NALU_DEFAULT_MODEL || 'thinkingmachines/Inkling'
  const prefix = `NALU_${lane.toUpperCase()}`
  const provider = (lane !== 'agent' && env[`${prefix}_BASE_URL`]) || env.TINKER_BASE_URL || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
  const apiKey = (lane !== 'agent' && env[`${prefix}_API_KEY`]) || env.TINKER_API_KEY
  if (!apiKey) throw new Error('The incumbent provider credential is unavailable')
  return {model, provider: provider.replace(/\/+$/, ''), apiKey}
}

export function validateDomainBattery(battery, lane, trainingRows) {
  if (battery?.schemaVersion !== 1 || battery.lane !== lane || battery.surface !== 'web' || battery.split !== 'test') throw new Error('Missing lane-specific web test battery')
  if (!battery.provenance?.reviewer || !battery.provenance?.source || !battery.provenance?.version) throw new Error('Domain battery needs independent provenance')
  if (!Array.isArray(battery.cases) || battery.cases.length < 20) throw new Error('Domain promotion requires at least 20 held-out tasks')
  const train = new Set(trainingRows.map(promptHash)), seen = new Set(), categories = new Set()
  for (const item of battery.cases) {
    const p = promptHash(item)
    if (!item.id || !item.prompt || !item.system || !item.category || seen.has(p) || train.has(p)) throw new Error('Invalid, duplicate, or contaminated domain task')
    seen.add(p); categories.add(item.category)
    if (item.grader?.type !== 'json-exact' || !item.grader.expected || typeof item.grader.expected !== 'object') throw new Error('Domain tasks require explicit independently reviewed JSON ground truth')
  }
  if (categories.size < 3) throw new Error('Domain battery needs at least three task categories')
  return hash(JSON.stringify(battery))
}

export function gradeDomainAnswer(text, item) {
  let value
  try { value = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')) } catch { return false }
  const equal = (actual, expected) => {
    if (typeof expected === 'number') return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= (item.grader.tolerance ?? 1e-9)
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => equal(actual[i], v))
    if (expected && typeof expected === 'object') return actual && typeof actual === 'object' && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([k, v]) => equal(actual[k], v))
    return actual === expected
  }
  return !!equal(value, item.grader.expected)
}

export async function evaluateDomainGate({lane, candidate, incumbent, battery, trainingRows, sample, margin = 5}) {
  const batterySha256 = validateDomainBattery(battery, lane, trainingRows)
  const per = []
  // Same prompts/settings; alternate order so provider load does not always favor one side.
  for (let i = 0; i < battery.cases.length; i++) {
    const item = battery.cases[i], outputs = {}
    for (const key of i % 2 ? ['incumbent', 'candidate'] : ['candidate', 'incumbent']) {
      const reply = await sample(key === 'candidate' ? candidate : incumbent, item.system, item.prompt, 2048)
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('Incomplete domain evaluation; provider failed')
      outputs[key] = gradeDomainAnswer(reply, item)
    }
    per.push({id: item.id, category: item.category, critical: item.critical === true, ...outputs})
  }
  const score = key => 100 * per.filter(p => p[key]).length / per.length
  const noRegression = [...new Set(per.map(p => p.category))].every(c => per.filter(p => p.category === c && p.candidate).length >= per.filter(p => p.category === c && p.incumbent).length)
  const qualified = score('candidate') >= 90 && score('candidate') >= score('incumbent') + margin && noRegression && per.every(p => !p.critical || p.candidate)
  return {qualified, candidate: {score: score('candidate')}, incumbent: {score: score('incumbent')}, batterySha256, per, scope: 'Reviewed deterministic domain tasks; not evidence of general expert or frontier superiority'}
}

// Adapter performs fresh read/update/read. Restoration is required for BOTH an
// unsuccessful env write and a failed publication, and failure is never hidden.
export async function deployWithRollback({key, candidate, expected, read, write, deploy}) {
  const before = await read(key)
  if (before !== expected) throw new Error('Production model changed during evaluation; re-evaluate the current incumbent')
  try {
    await write(key, candidate)
    if (await read(key) !== candidate) throw new Error('Candidate model environment did not verify')
    if (await deploy() !== true) throw new Error('Release verification failed')
    return true
  } catch (cause) {
    const current = await read(key)
    if (current !== candidate && current !== before) throw new Error('Concurrent model change detected; automatic rollback refused', {cause})
    if (current !== before) await write(key, before)
    if (await read(key) !== before) throw new Error('Model environment rollback failed', {cause})
    throw new Error('Candidate release failed; previous model environment restored', {cause})
  }
}
