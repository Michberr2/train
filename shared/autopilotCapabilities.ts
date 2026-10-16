import { PORTABLE_OUTPUT_TYPES } from './autopilotFiles'

export const BACKGROUND_OUTPUT_TYPES = [...PORTABLE_OUTPUT_TYPES, 'doc', 'email', 'social'] as const
export function needsOpenWorkspace(node: { type?: string; platform?: string; format?: string }): boolean {
  return ['pdf', 'slides', 'sheet', 'csv', 'website', 'image', 'video'].includes(node.type || '') ||
    (node.type === 'social' && (node.format === 'video' || /tiktok|reel|short/i.test(node.platform || '')))
}

const TYPES = new Set(['agent', 'trigger', 'websearch', 'fetchurl', 'http', 'memory', 'router', 'filter', 'approval', 'foreach', 'planner', ...BACKGROUND_OUTPUT_TYPES, 'pdf', 'slides', 'sheet', 'csv', 'website', 'image', 'video'])
export function graphErrors(nodes: { id: string; type?: string }[], edges: { from: string; to: string }[]): string[] {
  const ids = new Set(nodes.map(n => n.id))
  if (!nodes.length) return ['Add a step before running this pipeline.']
  if (ids.size !== nodes.length || nodes.some(n => !n.id)) return ['Each pipeline step needs a unique ID. Rebuild or reimport the affected steps.']
  const unsupported = nodes.find(n => !TYPES.has(n.type || ''))
  if (unsupported) return [`Unsupported pipeline step: ${unsupported.type || 'missing type'}. Edit or rebuild that step.`]
  if (edges.some(e => !ids.has(e.from) || !ids.has(e.to))) return ['A connection points to a missing step. Remove it and reconnect the pipeline.']
  const counts = new Map(nodes.map(n => [n.id, 0]))
  for (const e of edges) counts.set(e.to, counts.get(e.to)! + 1)
  const queue = nodes.filter(n => counts.get(n.id) === 0).map(n => n.id)
  let visited = 0
  for (let i = 0; i < queue.length; i++) {
    visited++
    for (const e of edges.filter(e => e.from === queue[i])) {
      counts.set(e.to, counts.get(e.to)! - 1)
      if (counts.get(e.to) === 0) queue.push(e.to)
    }
  }
  return visited === nodes.length ? [] : ['The pipeline has a wiring loop — remove a circular connection.']
}
