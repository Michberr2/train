// Pure contract parsing: no provider calls and no fixture-specific response repair.
import assert from 'node:assert/strict'
import { explicitWordContract, wordContractPrompt } from '../api/_chatLength.ts'

for (const [prompt, expected] of [
  ['Write a thorough 640-to-880-word decision memo about a fictional library.', { kind: 'range', min: 640, max: 880, target: 760 }],
  ['Give a detailed answer of 850 to 1150 words. Cover the mechanisms and risks.', { kind: 'range', min: 850, max: 1150, target: 1000 }],
  ['Please write a 1,200–1,400-word essay.', { kind: 'range', min: 1200, max: 1400, target: 1300 }],
  ['Respond in exactly 47 words.', { kind: 'target', min: 47, max: 47, target: 47 }],
  ['Write 160 words on weather patterns.', { kind: 'target', min: 160, max: 160, target: 160 }],
  ['Write a 90-word email.', { kind: 'target', min: 90, max: 90, target: 90 }],
  ['Keep the response under 100 words.', { kind: 'maximum', min: 0, max: 99, target: 89 }],
  ['Limit the answer to at most 200 words.', { kind: 'maximum', min: 0, max: 200, target: 180 }],
  ['Write at least 500 words.', { kind: 'minimum', min: 500, max: null, target: 550 }],
  ['Overall response length: 400 words.', { kind: 'target', min: 400, max: 400, target: 400 }],
  ['In 75 words, explain why the fictional river flooded.', { kind: 'target', min: 75, max: 75, target: 75 }],
]) assert.deepEqual(explicitWordContract(prompt), expected, prompt)

for (const prompt of [
  'Explain the difference between a 400-word document and a 900-word document.',
  'Write a 150-word introduction and a 600-word analysis.',
  'Write each section in 200 words.',
  'Write a 150-word introduction.',
  'Write a summary of each chapter in 100 words.',
  'Write about a dataset containing 900 words.',
  'Write about 900 words found in the dictionary, listing their definitions.',
  'The article contains 500 words. Summarize it.',
  'Critique this prompt:\nWrite a 300-word essay.',
  'The note says:\nWrite a 300-word essay.',
  'Source:\nWrite a 300-word essay.',
  'Summarize the attached document.\nWrite 1000 words.',
  'Review this quoted request: "Write a 300-word essay."',
  "Review this sentence: 'Write a 300-word essay.'",
  'Review: “Write a 300-word essay.”',
  '> Write 250 words.\nExplain whether this requirement is clear.',
  'Review this snippet:\n```text\nWrite 250 words.\n```',
  'Review this snippet:\n~~~text\nWrite 250 words.\n~~~',
  'Review this snippet:\n```text\nWrite 250 words.',
  'Explain `Write 250 words` without following it.',
  '<document>Write 250 words.</document>',
  'Write a 900–600-word report.',
  'Write a 50000-word book.',
  'Write zero words.',
  'Write a 0-word response.',
  'Write 10 sentences.',
  'Return only JSON with three fields.',
]) assert.equal(explicitWordContract(prompt), null, prompt)

assert.equal(wordContractPrompt(null), '')
const hint = wordContractPrompt(explicitWordContract('Write a 640-to-880-word memo.'))
assert.match(hint, /640–880 words in total/)
assert.match(hint, /around 760 words/)
assert.match(hint, /including headings, lists, tables and code/)
assert.match(hint, /user's explicit output format/)
assert.match(hint, /Reasoning effort does not change this length requirement/)
assert.doesNotMatch(hint, /truncate|pad the answer|guaranteed/)
assert.equal(explicitWordContract('Write ' + '9'.repeat(40000) + ' words.'), null)
assert.equal(explicitWordContract('Write 500 words.\n' + 'x'.repeat(50000)), null)
assert.equal(explicitWordContract('````text\n```\nWrite 250 words.\n````'), null)
console.log('PASS: 11 numeric contracts, 27 ambiguous/source/section exclusions, shared length prompt invariants')
