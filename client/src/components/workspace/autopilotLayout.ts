// Arrange only positions. Node configuration and graph semantics stay intact.
export function arrangeAutopilotNodes<T extends { id: string; x: number; y: number }>(nodes: T[], edges: { from: string; to: string }[]) {
  const levels = new Map<string, number>()
  const ids = new Set(nodes.map(node => node.id))
  const pending = new Set(ids)
  for (let pass = 0; pass < nodes.length && pending.size; pass++) {
    let changed = false
    for (const node of nodes) {
      if (!pending.has(node.id)) continue
      const inputs = edges.filter(edge => edge.to === node.id && ids.has(edge.from)).map(edge => edge.from)
      if (inputs.some(id => !levels.has(id))) continue
      levels.set(node.id, inputs.length ? Math.max(...inputs.map(id => levels.get(id)!)) + 1 : 0)
      pending.delete(node.id); changed = true
    }
    if (!changed) break
  }
  let remainder = Math.max(-1, ...levels.values()) + 1
  for (const id of pending) levels.set(id, remainder++)
  const rows = new Map<number, number>()
  return nodes.map(node => {
    const column = levels.get(node.id) || 0, row = rows.get(column) || 0
    rows.set(column, row + 1)
    return { ...node, x: 48 + column * 368, y: 72 + row * 284 }
  })
}
