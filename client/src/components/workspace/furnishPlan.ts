// Turn a shopping list into a real, walkable 3D room: map each item to a 3D
// furniture piece and auto-place them in a sensibly-proportioned room (big
// pieces flush to walls facing inward, tables/decor filled in, no overlaps).
// Standalone (no three.js import) so the ShoppingCard stays light.

export type FurnItem = { id: string; kind: string; x: number; z: number; rot: number; floor: number }
type Floor = { name?: string; viewBox?: { w?: number; h?: number }; shapes?: unknown[] }
type ShopItem = { name: string; category?: string }

// footprints [width, depth] in feet — mirror Blueprint3D's CATALOG.
const FP: Record<string, [number, number]> = {
  sofa: [7, 3], sectional: [9, 6], armchair: [3, 3], coffee: [4, 2], tv: [5, 1.5], rug: [8, 5],
  bed: [5, 6.7], nightstand: [1.6, 1.6], dresser: [5, 1.8], wardrobe: [4, 2], dining: [6, 3.5],
  island: [6, 3], fridge: [3, 2.8], range: [2.5, 2.5], tub: [5, 2.7], toilet: [1.6, 2.3],
  vanity: [3, 1.8], desk: [4, 2], bookshelf: [3, 1], plant: [1.6, 1.6], lamp: [1.2, 1.2], chair: [1.8, 1.8],
}

// keyword → furniture kind (most specific first).
const RULES: [RegExp, string][] = [
  [/sectional|l-shaped sofa/, 'sectional'],
  [/sofa|couch|settee|loveseat/, 'sofa'],
  [/armchair|accent chair|lounge chair|recliner|wingback/, 'armchair'],
  [/coffee table|cocktail table/, 'coffee'],
  [/dining (table|set)|kitchen table/, 'dining'],
  [/\btv\b|television|media (console|unit)|entertainment/, 'tv'],
  [/\brug\b|carpet/, 'rug'],
  [/\bbed\b|mattress|headboard/, 'bed'],
  [/nightstand|bedside/, 'nightstand'],
  [/dresser|chest of drawers/, 'dresser'],
  [/wardrobe|armoire|closet/, 'wardrobe'],
  [/kitchen island/, 'island'],
  [/fridge|refrigerator/, 'fridge'],
  [/range|stove|oven|cooktop/, 'range'],
  [/bathtub|\btub\b/, 'tub'],
  [/toilet/, 'toilet'],
  [/vanity|bathroom sink/, 'vanity'],
  [/\bdesk\b|writing table/, 'desk'],
  [/bookshelf|bookcase|shelving|shelf|cabinet|bar cabinet|credenza|sideboard|console/, 'bookshelf'],
  [/plant|fig tree|greenery|fern|monstera|topiary/, 'plant'],
  [/lamp|sconce|lighting|chandelier|pendant/, 'lamp'],
  [/stool|chair|seat|bench|ottoman|pouf/, 'chair'],
]
function mapKind(it: ShopItem): string | null {
  const s = `${it.name} ${it.category || ''}`.toLowerCase()
  for (const [re, kind] of RULES) if (re.test(s)) return kind
  return null
}

// Pieces that back up to a wall and face inward; everything else fills the room.
const WALL = new Set(['sofa', 'sectional', 'bed', 'tv', 'dresser', 'bookshelf', 'wardrobe', 'desk', 'vanity', 'fridge', 'range', 'island', 'tub', 'toilet'])

type Box = { x0: number; z0: number; x1: number; z1: number }
const worldBox = (cx: number, cz: number, w: number, d: number, rot: number): Box => {
  const sideways = Math.abs(Math.sin(rot)) > 0.5 // rotated to a left/right wall → swap extents
  const ew = sideways ? d : w
  const ed = sideways ? w : d
  return { x0: cx - ew / 2, z0: cz - ed / 2, x1: cx + ew / 2, z1: cz + ed / 2 }
}
const overlaps = (a: Box, b: Box, gap = 0.4) =>
  a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.z0 < b.z1 + gap && a.z1 > b.z0 - gap

export function planRoomFromItems(items: ShopItem[]): {
  floor: Floor
  furniture: FurnItem[]
  roomW: number
  roomH: number
  placed: number
  skipped: number
} {
  const kinds = (items || []).map(mapKind).filter((k): k is string => !!k)
  const n = Math.max(kinds.length, 1)
  const roomW = Math.min(46, Math.max(22, 18 + n * 1.4))
  const roomH = Math.min(34, Math.max(16, 14 + n * 0.9))
  const M = 1.5 // wall margin
  const placedBoxes: Box[] = []
  const furniture: FurnItem[] = []
  let id = 0
  const add = (kind: string, cx: number, cz: number, rot: number) => {
    const [w, d] = FP[kind] || [3, 3]
    furniture.push({ id: `r${id++}_${kind}`, kind, x: cx, z: cz, rot, floor: 0 })
    if (kind !== 'rug') placedBoxes.push(worldBox(cx, cz, w, d, rot))
  }

  // 1) a rug grounds the center (flat — never blocks anything).
  const rug = kinds.find((k) => k === 'rug')
  if (rug) add('rug', roomW / 2, roomH / 2, 0)

  // 2) wall pieces walk along the 4 walls, picking the emptiest wall each time.
  const walls = [
    { rot: 0, len: roomW - 2 * M, cur: M, at: (off: number, dep: number) => ({ cx: off, cz: M + dep / 2 }) }, // top
    { rot: Math.PI, len: roomW - 2 * M, cur: M, at: (off: number, dep: number) => ({ cx: off, cz: roomH - M - dep / 2 }) }, // bottom
    { rot: Math.PI / 2, len: roomH - 2 * M, cur: M, at: (off: number, dep: number) => ({ cx: M + dep / 2, cz: off }) }, // left
    { rot: -Math.PI / 2, len: roomH - 2 * M, cur: M, at: (off: number, dep: number) => ({ cx: roomW - M - dep / 2, cz: off }) }, // right
  ]
  const wallItems = kinds.filter((k) => WALL.has(k)).sort((a, b) => (FP[b][0] - FP[a][0]))
  const fill: string[] = []
  for (const kind of wallItems) {
    const [w, d] = FP[kind]
    // try the wall with the most remaining room
    const order = [...walls].sort((a, b) => (b.len - b.cur) - (a.len - a.cur))
    let done = false
    for (const wall of order) {
      if (wall.cur + w > wall.len + M) continue
      const off = wall.cur + w / 2
      const { cx, cz } = wall.at(off, d)
      const box = worldBox(cx, cz, w, d, wall.rot)
      if (placedBoxes.some((b) => overlaps(box, b))) { wall.cur += w + 0.6; continue }
      add(kind, cx, cz, wall.rot)
      wall.cur += w + 0.8
      done = true
      break
    }
    if (!done) fill.push(kind)
  }

  // 3) tables / chairs / decor fill the interior on a grid, avoiding collisions.
  const centerItems = [...kinds.filter((k) => !WALL.has(k) && k !== 'rug'), ...fill]
  const step = 2
  for (const kind of centerItems.sort((a, b) => FP[b][0] * FP[b][1] - FP[a][0] * FP[a][1])) {
    const [w, d] = FP[kind]
    let best: { cx: number; cz: number } | null = null
    let bestScore = Infinity
    for (let cz = M + d / 2 + 1.5; cz <= roomH - M - d / 2 - 1.5; cz += step) {
      for (let cx = M + w / 2 + 1.5; cx <= roomW - M - w / 2 - 1.5; cx += step) {
        const box = worldBox(cx, cz, w, d, 0)
        if (placedBoxes.some((b) => overlaps(box, b))) continue
        // prefer spots nearer the center for tables, edges for plants/lamps
        const dc = Math.hypot(cx - roomW / 2, cz - roomH / 2)
        const score = /plant|lamp/.test(kind) ? -dc : dc
        if (score < bestScore) { bestScore = score; best = { cx, cz } }
      }
    }
    if (best) add(kind, best.cx, best.cz, 0)
  }

  const floor: Floor = {
    name: 'Room',
    viewBox: { w: roomW, h: roomH },
    shapes: [{ type: 'rect', x: 0, y: 0, w: roomW, h: roomH, label: 'Room', stroke: 3 }],
  }
  return { floor, furniture, roomW, roomH, placed: furniture.length, skipped: (items?.length || 0) - kinds.length }
}
