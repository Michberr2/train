// Evaluate an actual locally generated candidate, never a canned engine reply.
// Source is reviewed before this developer-only Node execution step.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import vm from 'node:vm'

export const prompt = 'Write a JavaScript function named mergeIntervals(intervals). It accepts unsorted [start,end] number pairs and returns sorted merged intervals. Merge touching intervals too. Return [] for empty input. Do not mutate the input or its nested arrays. Return only the function source, with no explanation or markdown fences.'
const cases = [
  [[], []],
  [[[3, 4], [1, 2]], [[1, 2], [3, 4]]],
  [[[1, 4], [2, 3]], [[1, 4]]],
  [[[1, 2], [2, 5]], [[1, 5]]],
  [[[8, 10], [1, 3], [2, 6], [15, 18]], [[1, 6], [8, 10], [15, 18]]],
  [[[1, 1], [1, 2], [-4, -2], [-3, 0]], [[-4, 0], [1, 2]]],
]
export function evaluateSource(source) {
  assert.doesNotMatch(source, /```/, 'The user requested source without Markdown fences')
  const context = vm.createContext({})
  new vm.Script(`"use strict";\n${source}`).runInContext(context, { timeout: 1000 })
  const checked = []
  for (const [input, expected] of cases) {
    context.inputJSON = JSON.stringify(input)
    const result = new vm.Script(`(() => {
      const input = JSON.parse(inputJSON), before = JSON.stringify(input);
      const output = mergeIntervals(input);
      return { output: JSON.stringify(output), unchanged: JSON.stringify(input) === before,
        independent: output.every(pair => !input.includes(pair)) };
    })()`).runInContext(context, { timeout: 1000 })
    assert.equal(result.output, JSON.stringify(expected), `Incorrect result for ${JSON.stringify(input)}`)
    assert.equal(result.unchanged, true, 'The candidate mutated its input')
    assert.equal(result.independent, true, 'The candidate retained mutable nested input references')
    checked.push({ input, expected, unchanged: true, independent: true })
  }
  return { passed: true, prompt, cases: checked, scope: 'Actual candidate behavior for this coding task; this does not establish general model quality.' }
}
if (process.argv[2]) {
  const report = evaluateSource(await readFile(process.argv[2], 'utf8'))
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n')
  console.log(`PASS actual local candidate: ${cases.length} interval cases, input preservation, independent nested results, requested source format`)
}
