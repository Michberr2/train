import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({ entryPoints: ['api/_websiteDownloadContent.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false })
const { parseWebsiteDownloadContent: parse, compareWebsiteDownloadContent: compare, MAX_WEBSITE_DOWNLOAD_BYTES } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const bytes = source => new TextEncoder().encode(source)
let checks = 0
const passes = (source, expected) => { assert.deepEqual(compare(typeof source === 'string' ? bytes(source) : source, expected), { passed: true }); checks++ }
const fails = (source, expected, detail) => { const result = compare(typeof source === 'string' ? bytes(source) : source, expected); assert.equal(result.passed, false); if (detail) assert.match(result.detail, detail); checks++ }
const rejects = expected => { assert.throws(() => parse(expected)); checks++ }

const text = { format: 'text', equals: 'First line\n  Second line\n' }
passes('\uFEFFFirst line\r\n  Second line\r', text)
passes('First line\n  Second line\n', text)
fails('First line\nSecond line\n', text)
fails('First line\n  Second line', text)
fails('\uFEFF\uFEFFFirst line\n  Second line\n', text)
fails('PRIVATE_SECRET', { format: 'text', equals: 'PRIVATE_EXPECTED' })
assert.doesNotMatch(compare(bytes('PRIVATE_SECRET'), { format: 'text', equals: 'PRIVATE_EXPECTED' }).detail, /PRIVATE_/); checks++

const json = { format: 'json', equals: { rows: [{ name: 'A', amount: 12.5, selected: true }, { name: 'B', amount: 0, selected: false }], meta: null } }
passes('\uFEFF{ "meta": null, "rows": [{"selected": true, "amount":12.50, "name":"A"},{"amount":0,"selected":false,"name":"B"}] }', json)
fails(JSON.stringify({ ...json.equals, rows: [...json.equals.rows].reverse() }), json)
fails(JSON.stringify({ ...json.equals, rows: [{ ...json.equals.rows[0], amount: '12.5' }, json.equals.rows[1]] }), json)
fails(JSON.stringify({ ...json.equals, rows: [{ ...json.equals.rows[0], amount: 12.6 }, json.equals.rows[1]] }), json)
fails(JSON.stringify({ rows: json.equals.rows }), json)
fails(JSON.stringify({ ...json.equals, extra: 1 }), json)
fails('{"rows":[],}', json, /valid JSON/)
fails('undefined', json, /valid JSON/)
fails('{"amount":1e400}', { format: 'json', equals: { amount: 10 } })
passes('false', { format: 'json', equals: false })
passes('null', { format: 'json', equals: null })
passes('""', { format: 'json', equals: '' })
passes('{"__proto__":{"safe":true},"constructor":"literal"}', { format: 'json', equals: JSON.parse('{"__proto__":{"safe":true},"constructor":"literal"}') })

const csv = { format: 'csv', equals: [['Description', 'Quantity', 'Amount'], ['Consulting, "phase one"', '2', '12.50'], ['Two\nlines', '1', '0.00'], ['  whitespace  ', '', '7.00']] }
const csvSource = 'Description,Quantity,Amount\r\n"Consulting, ""phase one""",2,12.50\r\n"Two\nlines",1,0.00\r\n  whitespace  ,,7.00\r\n'
passes(csvSource, csv)
passes('\uFEFF' + csvSource, csv)
passes(csvSource.replace(/\r\n/g, '\n'), csv)
passes(csvSource.replace(/\r\n/g, '\r'), csv)
passes('"a\r\nb","""quoted"""', { format: 'csv', equals: [['a\r\nb', '"quoted"']] })
passes('""', { format: 'csv', equals: [['']] })
passes('a,', { format: 'csv', equals: [['a', '']] })
passes('a\n\n', { format: 'csv', equals: [['a'], ['']] })
fails(csvSource.replace('12.50', '1250'), csv)
fails(csvSource.replace('  whitespace  ,,7.00\r\n', ''), csv)
fails(csvSource + 'Extra,1,3.00\r\n', csv)
fails(csvSource.replace('  whitespace  ', 'whitespace'), csv)
fails(csvSource.replace('Quantity,Amount', 'Quantity,Amount,Extra'), csv, /valid CSV/)
fails('a,"unterminated', { format: 'csv', equals: [['a', 'unterminated']] }, /valid CSV/)
fails('a,b"c', { format: 'csv', equals: [['a', 'b"c']] }, /valid CSV/)
fails('"a" trailing,b', { format: 'csv', equals: [['a trailing', 'b']] }, /valid CSV/)
fails('"a" ,b', { format: 'csv', equals: [['a ', 'b']] }, /valid CSV/)

for (const empty of ['', '\uFEFF', ' \r\n\t']) fails(empty, text, /empty/)
fails(new Uint8Array([0xff, 0xfe, 0x61]), text, /UTF-8/)
fails(new Uint8Array([0xc3, 0x28]), text, /UTF-8/)
fails(new Uint8Array([0x61, 0, 0x62]), text, /binary/)
fails(bytes('a'.repeat(MAX_WEBSITE_DOWNLOAD_BYTES + 1)), text, /size/)
assert.equal(MAX_WEBSITE_DOWNLOAD_BYTES, 1048576); checks++

for (const invalid of [null, [], {}, { format: 'xml', equals: '<a/>' }, { format: 'text', equals: 'x', eval: 'x' }, { format: 'text', equals: '' }, { format: 'text', equals: ' ' }, { format: 'text', equals: 1 }, { format: 'csv', equals: [] }, { format: 'csv', equals: [[]] }, { format: 'csv', equals: [['a'], ['b', 'c']] }, { format: 'csv', equals: [['a', 1]] }, { format: 'json', equals: undefined }, { format: 'json', equals: NaN }, { format: 'json', equals: Infinity }, { format: 'json', equals: new Date() }, { format: 'json', equals: () => 1 }, { format: 'json', equals: new Array(3) }, { format: 'json', equals: 'x'.repeat(4001) }, { format: 'json', equals: { ['x'.repeat(4001)]: 1 } }, { format: 'json', equals: Array(2000).fill(0) }, { format: 'text', equals: 'é'.repeat(16000) }]) rejects(invalid)
const cyclic = {}; cyclic.self = cyclic; rejects({ format: 'json', equals: cyclic })
const symbols = { format: 'text', equals: 'x', [Symbol('extra')]: true }; rejects(symbols)
const hidden = { format: 'text', equals: 'x' }; Object.defineProperty(hidden, 'extra', { value: true }); rejects(hidden)
const sparseCsv = new Array(1); sparseCsv.extra = 'x'; rejects({ format: 'csv', equals: [sparseCsv] })
let getterCalled = false
rejects({ format: 'json', equals: { get x() { getterCalled = true; return 1 } } }); assert.equal(getterCalled, false); checks++
const nested = depth => depth ? [nested(depth - 1)] : 1
assert.deepEqual(parse({ format: 'json', equals: nested(8) }).equals, nested(8)); checks++
rejects({ format: 'json', equals: nested(9) })
assert.equal(parse({ format: 'json', equals: Array(1999).fill(0) }).equals.length, 1999); checks++
const snapshot = parse(json); json.equals.rows[0].amount = 99; assert.equal(snapshot.equals.rows[0].amount, 12.5); checks++
console.log(`Website download content regressions passed: ${checks} checks for text normalization; exact CSV/JSON contents; malformed, missing and extra data; metadata limits; UTF-8, binary, empty and oversized downloads. No browser or network calls.`)
