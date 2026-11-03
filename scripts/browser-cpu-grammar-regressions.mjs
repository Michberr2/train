import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
const directory = await mkdtemp(tmpdir() + '/nalu-cpu-grammar-')
try {
  // Emscripten's browser bundle needs a real module URL in Node diagnostics.
  await build({ entryPoints: ['client/src/lib/browserCPUGrammar.ts'], outfile: directory + '/grammar.mjs', bundle: true, format: 'esm', platform: 'node', banner: { js: 'import {createRequire} from "node:module";import{fileURLToPath}from"node:url";const require=createRequire(import.meta.url),__filename=fileURLToPath(import.meta.url);' }, plugins: [{ name: 'node-diagnostic-url', setup(build) { build.onLoad({ filter: /web-xgrammar\/lib\/index\.js$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')).replaceAll('"MLC_DUMMY_PATH"', 'import.meta.url') + '\nconst {GrammarCompiler,GrammarMatcher,TokenizerInfo}=globalThis.xgrammar;export{GrammarCompiler,GrammarMatcher,TokenizerInfo};', loader: 'js' })) } }] })
  const { browserCPUGrammar } = await import(pathToFileURL(directory + '/grammar.mjs'))
  const bytes = [...Array.from({ length: 94 }, (_, i) => i + 33), ...Array.from({ length: 12 }, (_, i) => i + 161), ...Array.from({ length: 82 }, (_, i) => i + 174)]
  const encoded = new Map(bytes.map(byte => [byte, byte])); let extra = 0
  for (let byte = 0; byte < 256; byte++) if (!encoded.has(byte)) encoded.set(byte, 256 + extra++)
  const vocabulary = new Map(Array.from({ length: 128 }, (_, id) => [String.fromCharCode(encoded.get(id)), id])); vocabulary.set('<eos>', 128)
  const schema = JSON.stringify({ type: 'object', additionalProperties: false, properties: { message: { type: 'string' }, actions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { enum: ['sum'] }, arguments: { type: 'object', additionalProperties: false, properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }, required: ['name', 'arguments'] } } }, required: ['message', 'actions'] })
  const accepts = async value => {
    const grammar = await browserCPUGrammar(vocabulary, 129, [128], schema)
    try {
      for (const char of JSON.stringify(value)) { await grammar.ready(); const logits = new Float32Array(129); grammar.mask(logits); const token = char.charCodeAt(0); if (logits[token] === -Infinity) return false; grammar.accept([BigInt(token)]) }
      await grammar.ready(); const logits = new Float32Array(129); grammar.mask(logits); if (logits[128] === -Infinity) return false
      grammar.accept([128n]); await grammar.ready(); return true
    } finally { await grammar.dispose() }
  }
  assert.equal(await accepts({ message: 'Adding them.', actions: [{ name: 'sum', arguments: { a: 2, b: 3 } }] }), true)
  assert.equal(await accepts({ message: '', actions: [{ name: 'sum', arguments: {} }] }), false)
  assert.equal(await accepts({ message: '', actions: [{ name: 'sum', arguments: { a: 'two', b: 3 } }] }), false)
  assert.equal(await accepts({ message: '', actions: [{ name: 'unknown', arguments: { a: 2, b: 3 } }] }), false)
  assert.equal(await accepts({ message: 'An ordinary answer.', actions: [] }), true)
  console.log('PASS Actual browser CPU score masks allow valid arguments and EOS, reject missing/wrong/unknown actions before sampling, and preserve ordinary replies')
} finally { await rm(directory, { recursive: true, force: true }) }
