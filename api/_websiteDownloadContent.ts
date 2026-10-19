import type { WebsiteDownloadContent, WebsiteJsonValue } from '../shared/websiteBehavior'

export const MAX_WEBSITE_DOWNLOAD_BYTES = 1048576
const MAX_EXPECTED_BYTES = 32000
const MAX_JSON_DEPTH = 8
const MAX_JSON_NODES = 2000
const MAX_JSON_STRING = 4000

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function dataProperties(value: object): void {
  if (Object.getOwnPropertySymbols(value).length || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => !('value' in descriptor) || !descriptor.enumerable && !(Array.isArray(value) && key === 'length'))) {
    throw new Error('Website download expectations must contain ordinary JSON data.')
  }
}

const normalizeText = (value: string) => value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

/** Validate before model/browser work. Expected data is private metadata, never
 * executable code; return a fresh value with no caller-owned nested objects. */
export function parseWebsiteDownloadContent(value: unknown): WebsiteDownloadContent {
  if (!plainObject(value)) throw new Error('Website download content must be an object.')
  dataProperties(value)
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('format') || !keys.includes('equals')) throw new Error('Website download content requires only format and equals.')
  let result: WebsiteDownloadContent
  if (value.format === 'text') {
    if (typeof value.equals !== 'string' || !normalizeText(value.equals).trim()) throw new Error('Text download expectations require nonempty text.')
    result = { format: 'text', equals: value.equals }
  } else if (value.format === 'json') {
    let nodes = 0
    const ancestors = new Set<object>()
    const copy = (input: unknown, depth: number): WebsiteJsonValue => {
      if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('JSON download expectations exceed the supported structure limits.')
      if (input === null) return null
      if (typeof input === 'boolean') return input
      if (typeof input === 'number') {
        if (!Number.isFinite(input)) throw new Error('JSON download expectations require finite numbers.')
        return input
      }
      if (typeof input === 'string') {
        if (input.length > MAX_JSON_STRING) throw new Error('JSON download expectation strings exceed the supported length.')
        return input
      }
      if (!Array.isArray(input) && !plainObject(input)) throw new Error('JSON download expectations require JSON values.')
      dataProperties(input)
      if (ancestors.has(input)) throw new Error('JSON download expectations cannot contain cycles.')
      ancestors.add(input)
      let output: WebsiteJsonValue
      if (Array.isArray(input)) {
        if (input.length > MAX_JSON_NODES || Object.keys(input).length !== input.length || Object.keys(input).some((key, index) => key !== String(index))) throw new Error('JSON download expectations require complete ordinary arrays.')
        output = input.map(item => copy(item, depth + 1))
      } else {
        output = Object.fromEntries(Object.entries(input).map(([key, item]) => {
          if (key.length > MAX_JSON_STRING) throw new Error('JSON download expectation keys exceed the supported length.')
          return [key, copy(item, depth + 1)]
        }))
      }
      ancestors.delete(input)
      return output
    }
    result = { format: 'json', equals: copy(value.equals, 0) }
  } else if (value.format === 'csv') {
    if (!Array.isArray(value.equals) || !value.equals.length) throw new Error('CSV download expectations require complete ordered rows.')
    dataProperties(value.equals)
    const width = Array.isArray(value.equals[0]) ? value.equals[0].length : 0
    if (!width) throw new Error('CSV download expectations require at least one column.')
    const rows = value.equals.map(row => {
      if (!Array.isArray(row) || row.length !== width || Object.keys(row).length !== width || Object.keys(row).some((key, index) => key !== String(index))) throw new Error('CSV download expectations require consistent complete columns.')
      dataProperties(row)
      if (row.some(cell => typeof cell !== 'string')) throw new Error('CSV download expectation cells must be strings.')
      return row.map(cell => cell as string)
    })
    if (Object.keys(value.equals).length !== rows.length || Object.keys(value.equals).some((key, index) => key !== String(index))) throw new Error('CSV download expectations require complete ordinary rows.')
    result = { format: 'csv', equals: rows }
  } else {
    throw new Error('Website download content format must be text, json or csv.')
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_EXPECTED_BYTES) throw new Error('Website download expectations exceed the supported metadata size.')
  return result
}

/** Strict quote grammar with RFC escaped quotes and embedded newlines. Accept
 * common CRLF, LF and CR record separators; preserve every character inside
 * quoted cells. A final record separator is not an extra empty record. */
function parseCsv(source: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = ''
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start'
  let endedRecord = false
  const finishField = () => { row.push(field); field = ''; state = 'start' }
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    endedRecord = false
    if (state === 'quoted') {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index++ }
        else state = 'closed'
      } else field += char
      continue
    }
    if (char === ',') { finishField(); continue }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index++
      finishField(); rows.push(row); row = []; endedRecord = true
      continue
    }
    if (state === 'closed') throw new Error('Malformed CSV.')
    if (char === '"') {
      if (state !== 'start') throw new Error('Malformed CSV.')
      state = 'quoted'
    } else { field += char; state = 'plain' }
  }
  if (state === 'quoted') throw new Error('Malformed CSV.')
  if (!endedRecord) { finishField(); rows.push(row) }
  if (rows.some(row => row.length !== rows[0].length)) throw new Error('Malformed CSV.')
  return rows
}

function sameJson(actual: unknown, expected: WebsiteJsonValue): boolean {
  if (actual === expected) return true
  if (expected === null || typeof expected !== 'object' || !actual || typeof actual !== 'object') return false
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => sameJson(actual[index], value))
  if (Array.isArray(actual)) return false
  const keys = Object.keys(expected), candidate = actual as Record<string, unknown>
  return Object.keys(candidate).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(candidate, key) && sameJson(candidate[key], expected[key]))
}

/** Fixed diagnostics deliberately never interpolate filenames, bytes, parsed
 * values or expected contents: downloaded user data must not enter repair logs. */
export function compareWebsiteDownloadContent(bytes: Uint8Array, expected: WebsiteDownloadContent): { passed: boolean; detail?: string } {
  let contract: WebsiteDownloadContent
  try { contract = parseWebsiteDownloadContent(expected) } catch { return { passed: false, detail: 'Invalid download content expectation.' } }
  if (!(bytes instanceof Uint8Array)) return { passed: false, detail: 'Invalid download data.' }
  if (!bytes.byteLength) return { passed: false, detail: 'Download is empty.' }
  if (bytes.byteLength > MAX_WEBSITE_DOWNLOAD_BYTES) return { passed: false, detail: 'Download exceeds the supported size.' }
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return { passed: false, detail: 'Download is not valid UTF-8 text.' } }
  if (!source.trim()) return { passed: false, detail: 'Download is empty.' }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(source)) return { passed: false, detail: 'Download contains binary control bytes.' }
  if (contract.format === 'text') return normalizeText(source) === normalizeText(contract.equals) ? { passed: true } : { passed: false, detail: 'Downloaded text does not match the expected contents.' }
  source = source.replace(/^\uFEFF/, '')
  if (contract.format === 'json') {
    let actual: unknown
    try { actual = JSON.parse(source) } catch { return { passed: false, detail: 'Download is not valid JSON.' } }
    return sameJson(actual, contract.equals) ? { passed: true } : { passed: false, detail: 'Downloaded JSON does not match the expected contents.' }
  }
  let actual: string[][]
  try { actual = parseCsv(source) } catch { return { passed: false, detail: 'Download is not valid CSV.' } }
  const passed = actual.length === contract.equals.length && actual.every((row, index) => row.length === contract.equals[index].length && row.every((cell, column) => cell === contract.equals[index][column]))
  return passed ? { passed: true } : { passed: false, detail: 'Downloaded CSV does not match the expected contents.' }
}
