import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const require = createRequire(import.meta.url), directory = await mkdtemp(tmpdir() + '/nalu-tool-grammar-')
try {
  // Export only a diagnostic handle to the actual grammar bundled in the
  // pinned GPU runtime. Its implementation is unchanged; no model is mocked.
  const library = require.resolve('@mlc-ai/web-llm'), source = await readFile(library, 'utf8')
  assert.ok(source.includes('libExports$1.GrammarCompiler'), 'Update the diagnostic export if the pinned engine changes its bundled grammar')
  await build({ stdin: { contents: source.replaceAll('\"MLC_DUMMY_PATH\"', 'import.meta.url') + '\nexport { libExports$1 as EmbeddedGrammar };', resolveDir: dirname(library) }, banner: { js: 'import {createRequire as nodeCreateRequire} from "node:module";const createRequire=value=>nodeCreateRequire(value==="MLC_DUMMY_PATH"?import.meta.url:value);' }, outfile: directory + '/grammar.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  await build({ entryPoints: ['client/src/lib/localAIProtocol.ts'], outfile: directory + '/protocol.mjs', bundle: true, format: 'esm', platform: 'node' })
  const { EmbeddedGrammar: grammar } = await import(pathToFileURL(directory + '/grammar.mjs'))
  const { localActionSchema } = await import(pathToFileURL(directory + '/protocol.mjs'))
  const tokens = Array.from({ length: 128 }, (_, index) => String.fromCharCode(index))
  const tokenizer = await grammar.TokenizerInfo.createTokenizerInfo(tokens, 'raw', false, 129, [128])
  const compiler = await grammar.GrammarCompiler.createGrammarCompiler(tokenizer)
  const schema = localActionSchema([{ type: 'function', function: { name: 'sum', description: 'Add two numbers.', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } } }])
  const compiled = await compiler.compileJSONSchema(JSON.stringify(schema), true, undefined, undefined, true, 16)
  const accepts = async value => { const matcher = await grammar.GrammarMatcher.createGrammarMatcher(compiled, undefined, true); try { return matcher._acceptString(JSON.stringify(value)) && matcher.isTerminated() } finally { matcher.dispose() } }
  assert.equal(await accepts({ message: 'Adding them.', actions: [{ name: 'sum', arguments: { a: 2, b: 3 } }] }), true)
  assert.equal(await accepts({ message: '', actions: [{ name: 'sum', arguments: {} }] }), false)
  assert.equal(await accepts({ message: '', actions: [{ name: 'sum', arguments: { a: 'two', b: 3 } }] }), false)
  assert.equal(await accepts({ message: '', actions: [{ name: 'unknown', arguments: { a: 2, b: 3 } }] }), false)
  assert.equal(await accepts({ message: 'Just an answer.', actions: [] }), true)
  compiled.dispose(); compiler.dispose(); tokenizer.dispose()
  console.log('PASS The actual GPU grammar allows required tool arguments, rejects missing/wrong/unknown actions, and preserves ordinary answers')
} finally { await rm(directory, { recursive: true, force: true }) }
