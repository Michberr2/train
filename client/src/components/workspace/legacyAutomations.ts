type LegacyAutomation = { id: string; name: string; prompt: string; schedule: string; enabled: boolean }

/** Convert saved task definitions to executable flows without enabling any sends. */
export function importLegacyAutomations(raw: string | null, existing: { id: string }[], deleted: Set<string>) {
  let saved: unknown
  try { saved = JSON.parse(raw || 'null') } catch { return [] }
  if (!Array.isArray(saved)) return []
  const ids = new Set(existing.map((flow) => flow.id))
  return saved.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const task = item as LegacyAutomation
    if (typeof task.id !== 'string' || typeof task.name !== 'string' || typeof task.prompt !== 'string' || !task.prompt.trim()) return []
    const id = `legacy-automation-${task.id}`
    const defaultKey = `legacy-automation:${task.id}`
    if (ids.has(id) || deleted.has(defaultKey)) return []
    ids.add(id)
    const schedule: 'hourly' | 'daily' | 'weekly' | 'manual' = task.schedule === 'Hourly' ? 'hourly'
      : task.schedule === 'Weekly Mon' ? 'weekly' : /^Daily \d{1,2}:\d{2}$/.test(task.schedule) ? 'daily' : 'manual'
    const time = schedule === 'daily' ? task.schedule.slice(6).padStart(5, '0') : '09:00'
    return [{
      id, defaultKey, name: task.name, schedule, time, enabled: false,
      legacySchedule: typeof task.schedule === 'string' ? task.schedule : 'Manual',
      nodes: [{ id: `${id}-task`, type: 'agent' as const, agent: 'general', label: task.name, prompt: task.prompt, x: 60, y: 60 }],
      edges: [],
    }]
  })
}
