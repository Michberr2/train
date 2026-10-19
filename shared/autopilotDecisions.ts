/** Missing or ambiguous AI decisions must not authorize downstream actions. */
function answerText(value: string): string {
  const text = value.trim()
  const quoted = text.match(/^(["'`])([\s\S]*)\1$/)
  return (quoted ? quoted[2] : text).trim()
}

export function selectFlowBranch(raw: string, branches: { label: string }[]): string {
  const labels = branches.map(branch => typeof branch?.label === 'string' ? branch.label.trim().toLowerCase() : '')
  if (!labels.length || labels.some(label => !label) || new Set(labels).size !== labels.length) {
    throw new Error('Give each router branch a different, nonempty label.')
  }
  const answer = answerText(raw).toLowerCase()
  const exact = labels.indexOf(answer)
  const index = exact >= 0 ? exact : labels.indexOf(answer.replace(/[.!]$/, ''))
  if (index < 0) throw new Error('The router did not return one valid branch. Review the step and retry.')
  return branches[index].label
}

/** Old graphs may map every edge by order, but mixed/extra unlabeled edges
 * have no unambiguous meaning. Explicit labels can fan out to several targets. */
export function routerEdgeLabels(branches: { label: string }[], edges: { to: string; label?: string }[]): string[] {
  selectFlowBranch(branches[0]?.label || '', branches) // validate the complete label set
  if (new Set(edges.map(edge => edge.to)).size !== edges.length) throw new Error('A router cannot connect to the same step more than once. Remove the duplicate connection.')
  const labeled = edges.filter(edge => typeof edge.label === 'string' && edge.label.trim()).length
  if (labeled !== 0 && labeled !== edges.length) throw new Error('Label every router connection. Mixed labeled and unlabeled connections are ambiguous.')
  if (!labeled) {
    if (edges.length && edges.length !== branches.length) throw new Error('Label each router connection with its branch. Unlabeled connections must match the branch count exactly.')
    return edges.map((_, index) => branches[index].label)
  }
  return edges.map(edge => {
    const index = branches.findIndex(branch => branch.label.trim().toLowerCase() === edge.label!.trim().toLowerCase())
    if (index < 0) throw new Error(`Router connection "${edge.label}" does not match a branch.`)
    return branches[index].label
  })
}

export function routerGraphErrors(nodes: { id: string; type?: string; label?: string; branches?: { label: string }[] }[], edges: { from: string; to: string; label?: string }[]): string[] {
  const errors: string[] = []
  for (const node of nodes) if (node.type === 'router') {
    try { routerEdgeLabels(node.branches?.length ? node.branches : [{ label: 'A' }, { label: 'B' }], edges.filter(edge => edge.from === node.id)) }
    catch (error) { errors.push(`"${node.label || node.id}": ${error instanceof Error ? error.message : 'Invalid router connections.'}`) }
  }
  return errors
}

export function parseFlowFilter(raw: string): boolean {
  const answer = answerText(raw).toLowerCase().replace(/[.!]$/, '')
  if (answer !== 'yes' && answer !== 'no') throw new Error('The filter did not return yes or no. Review the step and retry.')
  return answer === 'yes'
}

export type PlannerAction = { action: 'search'; query: string } | { action: 'fetch'; url: string } | { action: 'finish'; answer: string }
export function parsePlannerAction(raw: string): PlannerAction {
  let value: unknown
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')) } catch { throw new Error('The planner returned incomplete or invalid JSON. Retry this step.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The planner did not return a valid action.')
  const action = value as Record<string, unknown>
  const field = action.action === 'search' ? 'query' : action.action === 'fetch' ? 'url' : action.action === 'finish' ? 'answer' : null
  if (!field || typeof action[field] !== 'string' || !action[field].trim()) throw new Error('The planner returned an empty or unsupported action.')
  if (action.action === 'fetch') {
    try { if (!['http:', 'https:'].includes(new URL(action.url as string).protocol)) throw new Error() } catch { throw new Error('The planner returned an invalid page URL.') }
  }
  return { action: action.action, [field]: (action[field] as string).trim() } as PlannerAction
}
