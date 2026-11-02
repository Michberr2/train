/** A bounded, versioned delegation manifest. It grants no credentials or
 * external actions; each task uses the existing owner-scoped execution paths. */
export const SWARM_WORK_KINDS = ['text', 'website', 'logo', 'palette', 'brand', 'blueprint', 'poster', 'canvas', 'shopping', 'motion', 'game', 'board', 'carousel', 'document', 'spreadsheet', 'slides', 'cad', 'email'] as const
export type SwarmWorkKind = typeof SWARM_WORK_KINDS[number]
export interface SwarmWorkPlan { version: 1; projects: { key: string; title: string; brief: string; tasks: { key: string; instructions: string; kind: SwarmWorkKind }[] }[] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`Invalid delegated ${label}.`)
  return value.trim()
}
function key(value: unknown): string {
  const result = text(value, 40, 'key')
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw Error('Use a stable letter/number key for delegated work.')
  return result
}
export function parseSwarmWorkPlan(input: unknown): SwarmWorkPlan {
  let value = input
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { throw Error('The delegated work plan is incomplete.') } }
  if (record(value) && value.unhandledRequests !== undefined) {
    if (!Array.isArray(value.unhandledRequests) || value.unhandledRequests.some(item => typeof item !== 'string' || item.length > 500)) throw Error('The delegation did not account for every requested action.')
    if (value.unhandledRequests.length) throw Error(`This request still needs a connected local tool: ${value.unhandledRequests.join('; ')}. No part of this plan has been started.`)
  }
  if (!record(value) || value.version !== 1 || !Array.isArray(value.projects) || !value.projects.length || value.projects.length > 12) throw Error('Choose between one and twelve project groups for this delegation.')
  const projectKeys = new Set<string>(); let tasks = 0
  const projects = value.projects.map(project => {
    if (!record(project) || !Array.isArray(project.tasks) || !project.tasks.length) throw Error('Each delegated project needs its actual tasks.')
    const projectKey = key(project.key)
    if (projectKeys.has(projectKey)) throw Error('Delegated project keys must be unique.')
    projectKeys.add(projectKey)
    const taskKeys = new Set<string>()
    return { key: projectKey, title: text(project.title, 100, 'project title'), brief: text(project.brief, 4000, 'project brief'), tasks: project.tasks.map(task => {
      if (!record(task) || !(SWARM_WORK_KINDS as readonly unknown[]).includes(task.kind)) throw Error('This delegation needs a supported local text or Studio tool. Other tools have not been started.')
      const taskKey = key(task.key)
      if (taskKeys.has(taskKey)) throw Error('Delegated task keys must be unique inside their project.')
      taskKeys.add(taskKey); tasks++
      return { key: taskKey, instructions: text(task.instructions, 2000, 'task instructions'), kind: task.kind as SwarmWorkKind }
    }) }
  })
  if (tasks > 24) throw Error('Delegate up to twenty-four tasks in one plan. No tasks have been silently dropped.')
  const plan: SwarmWorkPlan = { version: 1, projects }
  if (JSON.stringify(plan).length > 12000) throw Error('This delegation is too large for one local plan. Keep the full request and split it into project batches.')
  return plan
}
