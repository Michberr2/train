export const AUTOPILOT_NODE_WIDTH = 280
export const AUTOPILOT_PORT_Y = 43 // 1px card border + 20px inset + half the 44px handle
type Point = { x: number; y: number }
type Node = Point & { id: string }
type Size = { width: number; height: number }
type Box = { left: number; right: number; top: number; bottom: number }
export type ConnectionRoute = { path: string; points: Point[]; label: Point }

export const inputPort = (node: Node) => ({ x: node.x + 1, y: node.y + AUTOPILOT_PORT_Y })
export const outputPort = (node: Node) => ({ x: node.x + AUTOPILOT_NODE_WIDTH - 1, y: node.y + AUTOPILOT_PORT_Y })
export function connectionCurve(a: Point, b: Point) {
  const dx = Math.max(50, Math.abs(b.x - a.x) / 2)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}
const inside = (p: Point, b: Box) => p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom
const clear = (a: Point, b: Point, boxes: Box[]) => !boxes.some(box => a.y === b.y
  ? a.y > box.top && a.y < box.bottom && Math.max(a.x, b.x) > box.left && Math.min(a.x, b.x) < box.right
  : a.x > box.left && a.x < box.right && Math.max(a.y, b.y) > box.top && Math.min(a.y, b.y) < box.bottom)
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

function roundedPath(points: Point[], radius: number) {
  let path = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1]
    const before = distance(a, b), after = distance(b, c), r = Math.min(radius, before / 2, after / 2)
    if (!before || !after) continue
    const p = { x: b.x + (a.x - b.x) * r / before, y: b.y + (a.y - b.y) * r / before }
    const q = { x: b.x + (c.x - b.x) * r / after, y: b.y + (c.y - b.y) * r / after }
    path += ` L ${p.x} ${p.y} Q ${b.x} ${b.y} ${q.x} ${q.y}`
  }
  const end = points[points.length - 1]
  return `${path} L ${end.x} ${end.y}`
}

// Visibility grid shared by all connections. Every card contributes its outside
// boundaries; paths can always travel around the outermost non-overlapping cards.
function routingGrid(boxes: Box[], ports: Point[]) {
  const xs = [...new Set([...boxes.flatMap(b => [b.left, b.right]), ...ports.map(p => p.x)])].sort((a, b) => a - b)
  const ys = [...new Set([...boxes.flatMap(b => [b.top, b.bottom]), ...ports.map(p => p.y)])].sort((a, b) => a - b)
  const points = ys.flatMap(y => xs.map(x => ({ x, y })))
  const blocked = points.map(p => boxes.some(b => inside(p, b)))
  const neighbors = new Map<number, number[]>()
  const index = (p: Point) => ys.indexOf(p.y) * xs.length + xs.indexOf(p.x)
  const adjacent = (id: number) => {
    if (!neighbors.has(id)) {
      const x = id % xs.length, y = Math.floor(id / xs.length)
      neighbors.set(id, [x ? id - 1 : -1, x + 1 < xs.length ? id + 1 : -1, y ? id - xs.length : -1, y + 1 < ys.length ? id + xs.length : -1]
        .filter(next => next >= 0 && !blocked[next] && clear(points[id], points[next], boxes)))
    }
    return neighbors.get(id)!
  }
  return (start: Point, end: Point): Point[] | null => {
    const first = index(start), last = index(end)
    if (blocked[first] || blocked[last]) return null
    // A* with a small binary heap. Direction is part of the state so bends can
    // be discouraged without losing a valid route through a narrow corridor.
    const heap: { state: number; score: number; cost: number }[] = []
    const push = (entry: typeof heap[number]) => {
      let i = heap.length; heap.push(entry)
      while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent].score <= entry.score) break; heap[i] = heap[parent]; i = parent }
      heap[i] = entry
    }
    const pop = () => {
      const root = heap[0], tail = heap.pop()!
      if (heap.length) {
        let i = 0
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1
          if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child++
          if (heap[child].score >= tail.score) break
          heap[i] = heap[child]; i = child
        }
        heap[i] = tail
      }
      return root
    }
    const costs = new Map<number, number>([[first * 3, 0]]), previous = new Map<number, number>()
    push({ state: first * 3, cost: 0, score: distance(start, end) })
    while (heap.length) {
      const current = pop(), id = Math.floor(current.state / 3), direction = current.state % 3
      if (current.cost !== costs.get(current.state)) continue
      if (id === last) {
        const route: Point[] = []
        for (let state: number | undefined = current.state; state !== undefined; state = previous.get(state)) route.push(points[Math.floor(state / 3)])
        return route.reverse()
      }
      for (const next of adjacent(id)) {
        const nextDirection = points[id].y === points[next].y ? 1 : 2, state = next * 3 + nextDirection
        const cost = current.cost + distance(points[id], points[next]) + (direction && direction !== nextDirection ? 24 : 0)
        if (cost >= (costs.get(state) ?? Infinity)) continue
        costs.set(state, cost); previous.set(state, current.state)
        push({ state, cost, score: cost + distance(points[next], end) })
      }
    }
    return null
  }
}

export function layoutAutopilotConnections(nodes: Node[], edges: { from: string; to: string; label?: string }[], sizes: Record<string, Size>) {
  const boxes = nodes.map(n => ({ left: n.x, top: n.y, right: n.x + AUTOPILOT_NODE_WIDTH, bottom: n.y + (sizes[n.id]?.height || 240) }))
  const byId = new Map(nodes.map((n, i) => [n.id, { node: n, box: boxes[i] }]))
  const grids = new Map<number, ReturnType<typeof routingGrid>>()
  const routes = edges.map((edge): ConnectionRoute | null => {
    const from = byId.get(edge.from), to = byId.get(edge.to)
    if (!from || !to) return null
    const a = outputPort(from.node), b = inputPort(to.node)
    let points: Point[] = [], gap = 18
    // Retry with less clearance for deliberately close cards. Only overlapping
    // cards can make a port physically inaccessible; do not change saved positions.
    for (const padding of [18, 4, 0]) {
      if (!grids.has(padding)) {
        const obstacles = boxes.map(box => ({ left: box.left - padding, right: box.right + padding, top: box.top - padding, bottom: box.bottom + padding }))
        grids.set(padding, routingGrid(obstacles, nodes.flatMap(n => [{ x: n.x - padding, y: n.y + AUTOPILOT_PORT_Y }, { x: n.x + AUTOPILOT_NODE_WIDTH + padding, y: n.y + AUTOPILOT_PORT_Y }])))
      }
      const start = { x: from.box.right + padding, y: a.y }, end = { x: to.box.left - padding, y: b.y }
      if (!clear(a, start, boxes.filter(box => box !== from.box)) || !clear(end, b, boxes.filter(box => box !== to.box))) continue
      const route = grids.get(padding)!(start, end)
      if (route) { points = [a, ...route, b]; gap = padding; break }
    }
    if (!points.length) points = [a, { x: a.x + 24, y: a.y }, { x: a.x + 24, y: b.y }, b]
    // Collapse collinear grid coordinates before rounding the actual turns.
    points = points.filter((p, i, list) => !i || p.x !== list[i - 1].x || p.y !== list[i - 1].y)
    points = points.filter((p, i, list) => !i || i === list.length - 1 || !((list[i - 1].x === p.x && p.x === list[i + 1].x) || (list[i - 1].y === p.y && p.y === list[i + 1].y)))
    const segments = points.slice(1).map((p, i) => ({ a: points[i], b: p, length: distance(points[i], p) })).sort((a, b) => b.length - a.length)
    const labelWidth = Math.max(76, Math.min(edge.label?.length || 0, 18) * 7.6)
    const labelPoints = segments.map(s => ({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }))
    const label = labelPoints.find(p => !boxes.some(box => p.x + labelWidth / 2 > box.left && p.x - labelWidth / 2 < box.right && p.y + 13 > box.top && p.y - 13 < box.bottom)) || labelPoints[0] || a
    return { path: roundedPath(points, Math.min(10, gap / 2)), points, label }
  })
  const geometry = [...boxes.flatMap(b => [{ x: b.left, y: b.top }, { x: b.right, y: b.bottom }]), ...routes.flatMap((route, i) => route ? [...route.points, ...(edges[i].label ? [{ x: route.label.x - 80, y: route.label.y - 16 }, { x: route.label.x + 80, y: route.label.y + 16 }] : [])] : [])]
  const minX = Math.min(0, ...geometry.map(p => p.x)) - 32, minY = Math.min(0, ...geometry.map(p => p.y)) - 32
  return { routes, minX, minY, w: Math.max(720, Math.max(0, ...geometry.map(p => p.x)) - minX + 60), h: Math.max(460, Math.max(0, ...geometry.map(p => p.y)) - minY + 100) }
}
