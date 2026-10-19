import fs from 'node:fs'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const contentOf = row => row.turns
  ? {system: row.system || '', turns: row.turns.map(t => ({user: t.user, assistant: t.assistant}))}
  : {system: row.system || '', user: row.user, assistant: row.assistant}
export const contentHash = row => sha256(JSON.stringify(contentOf(row)))
export const promptHash = row => sha256(String(row.turns?.[0]?.user ?? row.user ?? row.prompt ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim())
const meaningful = v => typeof v === 'string' && v.trim().length > 0
// A conservative additional screen, not a substitute for the recorded review.
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-)?|tml-|gh[pousr]_)[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|(?:api[_-]?key|authorization|password|access[_-]?token)\s*[=:]\s*["']?(?!\[REDACTED\]|<redacted>|example|placeholder)[A-Za-z0-9_+\/-]{16,}/i

export function rowEligibility(row, metadata = row?.training) {
  const errors = []
  if (!row || typeof row !== 'object') return ['invalid row']
  const turns = row.turns || [{user: row.user, assistant: row.assistant}]
  if (!Array.isArray(turns) || !turns.length || turns.length > 32 || turns.some(t => !meaningful(t?.user) || !meaningful(t?.assistant))) errors.push('invalid conversation')
  if (row.system !== undefined && typeof row.system !== 'string') errors.push('invalid system')
  if (!metadata || metadata.schemaVersion !== 1) return [...errors, 'missing reviewed provenance']
  if (metadata.contentSha256 !== contentHash(row)) errors.push('content changed after review')
  if (!['synthetic', 'licensed', 'user-session'].includes(metadata.source?.kind) || !meaningful(metadata.source?.id) || !meaningful(metadata.source?.version)) errors.push('missing source identity/version')
  if (metadata.source?.kind === 'synthetic' && !meaningful(metadata.source?.teacher)) errors.push('missing teacher identity')
  if (metadata.consent?.remoteTraining !== true || !meaningful(metadata.consent?.recordId)) errors.push('remote training not authorized')
  if (metadata.review?.redaction !== 'passed' || metadata.review?.quality !== 'passed' || !meaningful(metadata.review?.reviewer) || !meaningful(metadata.review?.evidence)) errors.push('independent quality/redaction review missing')
  if (metadata.review?.reviewer === metadata.source?.teacher || metadata.review?.reviewer === 'teacher-self-report') errors.push('teacher self-report is not independent verification')
  if (!['terminal', 'web'].includes(metadata.surface) || !/^[a-z][a-z0-9_-]{0,31}$/.test(metadata.domain || '')) errors.push('invalid surface/domain')
  if (!['train', 'validation', 'test'].includes(metadata.split)) errors.push('missing data split')
  if (metadata.deleted === true || metadata.consent?.revoked === true) errors.push('consent revoked or row deleted')
  if (secret.test(JSON.stringify(contentOf(row)))) errors.push('potential secret requires redaction')
  return errors
}

export function reviewDataset(rows, manifest = null) {
  const accepted = [], rejected = [], seen = new Map()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let hash
    try { hash = contentHash(row) } catch { rejected.push({line: i + 1, reasons: ['invalid row']}); continue }
    const metadata = manifest?.rows?.[hash] || row.training
    const errors = rowEligibility(row, metadata)
    const prompt = promptHash(row)
    if (seen.has(prompt)) errors.push(seen.get(prompt) === metadata?.split ? 'duplicate normalized prompt' : 'prompt overlaps data splits')
    seen.set(prompt, metadata?.split)
    if (errors.length) rejected.push({line: i + 1, contentSha256: hash, reasons: errors})
    else accepted.push({...row, training: metadata})
  }
  return {accepted, rejected}
}

export function loadReviewedDataset(file, {strict = true} = {}) {
  const raw = fs.readFileSync(file, 'utf8')
  const rows = raw.split('\n').filter(l => l.trim()).map((line, i) => {
    try { return JSON.parse(line) } catch { throw new Error(`Invalid dataset JSON at row ${i + 1}`) }
  })
  const sidecar = `${file}.review.json`
  const manifest = fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : null
  if (manifest && (manifest.schemaVersion !== 1 || manifest.datasetSha256 !== sha256(raw))) throw new Error('Dataset review manifest does not match current file')
  const result = reviewDataset(rows, manifest)
  if (strict && (result.rejected.length || !result.accepted.length)) throw new Error(`Dataset not eligible: ${result.rejected.length} rejected, ${result.accepted.length} accepted; run dataset-policy.mjs --audit for reasons`)
  return {...result, datasetSha256: sha256(raw), total: rows.length}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2], file = process.argv[3]
    if (!['--audit', '--export'].includes(mode) || !file) throw new Error('Usage: node training/dataset-policy.mjs --audit|--export dataset.jsonl')
    const result = loadReviewedDataset(file, {strict: mode === '--export'})
    console.log(JSON.stringify(mode === '--export' ? result : {...result, accepted: result.accepted.map(row => ({contentSha256: contentHash(row), split: row.training.split, domain: row.training.domain, surface: row.training.surface}))}))
    if (result.rejected.length) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
