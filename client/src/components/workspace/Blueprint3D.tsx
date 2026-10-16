import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'

// Nalu's 3D house engine — the selling piece.
//  1. Builds a real 3D building from blueprint floors. Walls are derived
//     RELIABLY (perimeter shell + interior partitions from every room), so it
//     never collapses to bare slabs.
//  2. WALK THROUGH it in first person (PointerLock + WASD) — see how it feels.
//  3. FURNISH it: pick furniture from the palette, drag to place, rotate,
//     recolor, delete. Furniture persists and shows up on the walkthrough.
// Heights are realistic feet: ~9 ft storeys, 0.5 ft walls.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Shape = any
type Floor = { name?: string; viewBox?: { w?: number; h?: number }; shapes?: Shape[] }
type FurnItem = { id: string; kind: string; x: number; z: number; rot: number; floor: number }
type Props = { floors: Floor[]; mode: 'building' | 'site'; units?: string; storeKey?: string; startWalk?: boolean; initialFurniture?: FurnItem[] }

const lc = (s: unknown) => String(s || '').toLowerCase()
const isBuilding = (l: string) => /(resid|house|home|garage|guest|building|mansion|villa|cottage|structure)/.test(l)
const isHardscape = (l: string) => /(drive|park|patio|deck|walk|path|porch|terrace|court)/.test(l)
const isFixture = (l: string) =>
  /(fridge|refriger|range|stove|oven|cooktop|dishwash|\bsink\b|island|counter|microwave|\bbed\b|closet|sofa|couch|fireplace|toilet|\btub\b|\bbath\b|shower|vanity|washer|dryer|desk|\btable\b|nightstand|dresser|wardrobe|pantry|cabinet|\bstair|elevator|column|chair|rug)/.test(l)
const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d)

const WALL_H = 9
const WALL_T = 0.5
const INNER_T = 0.33
const SLAB = 1
const STOREY = WALL_H + SLAB
const EYE = 5.6

// --- furniture catalog (footprint in feet) ---------------------------------
const CATALOG: { kind: string; label: string; room: string; w: number; d: number }[] = [
  { kind: 'sofa', label: 'Sofa', room: 'Living', w: 7, d: 3 },
  { kind: 'sectional', label: 'Sectional', room: 'Living', w: 9, d: 6 },
  { kind: 'armchair', label: 'Armchair', room: 'Living', w: 3, d: 3 },
  { kind: 'coffee', label: 'Coffee table', room: 'Living', w: 4, d: 2 },
  { kind: 'tv', label: 'TV unit', room: 'Living', w: 5, d: 1.5 },
  { kind: 'rug', label: 'Rug', room: 'Living', w: 8, d: 5 },
  { kind: 'bed', label: 'Bed', room: 'Bedroom', w: 5, d: 6.7 },
  { kind: 'nightstand', label: 'Nightstand', room: 'Bedroom', w: 1.6, d: 1.6 },
  { kind: 'dresser', label: 'Dresser', room: 'Bedroom', w: 5, d: 1.8 },
  { kind: 'wardrobe', label: 'Wardrobe', room: 'Bedroom', w: 4, d: 2 },
  { kind: 'dining', label: 'Dining set', room: 'Dining', w: 6, d: 3.5 },
  { kind: 'island', label: 'Kitchen island', room: 'Kitchen', w: 6, d: 3 },
  { kind: 'fridge', label: 'Fridge', room: 'Kitchen', w: 3, d: 2.8 },
  { kind: 'range', label: 'Range', room: 'Kitchen', w: 2.5, d: 2.5 },
  { kind: 'tub', label: 'Bathtub', room: 'Bath', w: 5, d: 2.7 },
  { kind: 'toilet', label: 'Toilet', room: 'Bath', w: 1.6, d: 2.3 },
  { kind: 'vanity', label: 'Vanity', room: 'Bath', w: 3, d: 1.8 },
  { kind: 'desk', label: 'Desk', room: 'Office', w: 4, d: 2 },
  { kind: 'bookshelf', label: 'Bookshelf', room: 'Office', w: 3, d: 1 },
  { kind: 'plant', label: 'Plant', room: 'Decor', w: 1.6, d: 1.6 },
  { kind: 'lamp', label: 'Floor lamp', room: 'Decor', w: 1.2, d: 1.2 },
  { kind: 'chair', label: 'Chair', room: 'Decor', w: 1.8, d: 1.8 },
]
const ROOMS = ['Living', 'Bedroom', 'Dining', 'Kitchen', 'Bath', 'Office', 'Decor']
const footprint = (kind: string) => CATALOG.find((c) => c.kind === kind) || { w: 3, d: 3 }

type Pal = Record<string, THREE.MeshStandardMaterial>
function makeFurniture(kind: string, P: Pal): THREE.Group {
  const g = new THREE.Group()
  const B = (w: number, h: number, dd: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), m)
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh
  }
  const Cy = (r: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), m)
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh
  }
  switch (kind) {
    case 'sofa':
      B(7, 0.5, 3, P.fabric, 0, 0.5, 0.2)
      B(7, 1.4, 0.6, P.fabric, 0, 1.2, -1.2)
      B(0.6, 1.0, 3, P.fabric, -3.2, 0.95, 0); B(0.6, 1.0, 3, P.fabric, 3.2, 0.95, 0)
      B(3.0, 0.45, 2.0, P.fabric2, -1.6, 0.98, 0.25); B(3.0, 0.45, 2.0, P.fabric2, 1.6, 0.98, 0.25)
      break
    case 'sectional':
      B(9, 0.5, 3, P.fabric, 0, 0.5, 1.4); B(9, 1.4, 0.6, P.fabric, 0, 1.2, 0.1)
      B(3, 0.5, 6, P.fabric, -3, 0.5, -0.3); B(0.6, 1.4, 6, P.fabric, -4.2, 1.2, -0.3)
      break
    case 'armchair':
      B(3, 0.5, 3, P.fabric, 0, 0.5, 0.2); B(3, 1.4, 0.6, P.fabric, 0, 1.2, -1.2)
      B(0.5, 1.0, 3, P.fabric, -1.3, 0.95, 0); B(0.5, 1.0, 3, P.fabric, 1.3, 0.95, 0)
      break
    case 'coffee':
      B(4, 0.25, 2, P.wood, 0, 1.25, 0)
      for (const sx of [-1.7, 1.7]) for (const sz of [-0.7, 0.7]) B(0.2, 1.2, 0.2, P.wood, sx, 0.6, sz)
      break
    case 'tv':
      B(5, 1.5, 1.5, P.dark, 0, 0.75, 0)
      B(4.6, 2.6, 0.16, P.black, 0, 2.9, -0.5); B(4.0, 2.1, 0.05, P.screen, 0, 2.9, -0.41)
      break
    case 'rug':
      B(8, 0.06, 5, P.accent, 0, 0.04, 0); B(7.2, 0.07, 4.2, P.fabric2, 0, 0.05, 0)
      break
    case 'bed':
      B(5, 0.7, 6.7, P.wood, 0, 0.35, 0)
      B(4.6, 0.9, 5.7, P.white, 0, 0.95, 0.3)
      B(5, 2.6, 0.3, P.wood, 0, 1.3, -3.2)
      B(1.8, 0.4, 1.1, P.white, -1.0, 1.55, -2.6); B(1.8, 0.4, 1.1, P.white, 1.0, 1.55, -2.6)
      break
    case 'nightstand':
      B(1.6, 2, 1.6, P.wood, 0, 1, 0); B(1.2, 0.1, 0.1, P.metal, 0, 1.3, 0.85)
      break
    case 'dresser':
      B(5, 3, 1.8, P.wood, 0, 1.5, 0)
      for (const hx of [-1.2, 1.2]) for (const hy of [0.9, 1.6, 2.3]) B(0.9, 0.08, 0.1, P.metal, hx, hy, 0.95)
      break
    case 'wardrobe':
      B(4, 6.5, 2, P.wood, 0, 3.25, 0); B(0.05, 6.3, 0.05, P.metal, 0, 3.25, 1.02)
      break
    case 'dining': {
      B(6, 0.3, 3.5, P.wood, 0, 2.5, 0)
      for (const lx of [-2.6, 2.6]) for (const lz of [-1.4, 1.4]) B(0.25, 2.5, 0.25, P.wood, lx, 1.25, lz)
      for (const cz of [-1, 1] as const) for (const cx of [-1.8, 0, 1.8]) {
        B(1.4, 0.15, 1.4, P.fabric, cx, 1.6, cz * 2.4)
        B(1.4, 1.6, 0.16, P.fabric, cx, 2.4, cz * 3.0)
      }
      break
    }
    case 'island': {
      B(6, 3, 3, P.white, 0, 1.5, 0)
      B(6.4, 0.3, 3.4, P.marble, 0, 3.15, 0) // marble countertop
      for (const sx of [-1.6, 1.6]) { Cy(0.45, 0.9, P.fabric, sx, 0.45, 2.4); Cy(0.12, 1.5, P.metal, sx, 0.75, 2.4) }
      break
    }
    case 'fridge':
      B(3, 5.6, 2.8, P.metal, 0, 2.8, 0)
      B(0.15, 2.2, 0.18, P.dark, 1.35, 3.2, 1.35); B(0.15, 1.6, 0.18, P.dark, 1.35, 1.4, 1.35)
      break
    case 'range':
      B(2.5, 3, 2.5, P.metal, 0, 1.5, 0); B(2.5, 0.12, 2.5, P.dark, 0, 3.06, 0)
      for (const bx of [-0.6, 0.6]) for (const bz of [-0.6, 0.6]) Cy(0.35, 0.04, P.black, bx, 3.13, bz)
      break
    case 'tub':
      B(5, 2, 2.7, P.white, 0, 1, 0); B(4.4, 1.2, 2.1, P.screen, 0, 1.5, 0)
      break
    case 'toilet':
      B(1.4, 2, 0.6, P.white, 0, 1, -0.85); Cy(0.7, 1.4, P.white, 0, 0.7, 0.3); B(1.4, 0.18, 1.4, P.white, 0, 1.35, 0.3)
      break
    case 'vanity':
      B(3, 2.6, 1.8, P.wood, 0, 1.3, 0); B(3.2, 0.2, 2, P.marble, 0, 2.7, 0)
      Cy(0.06, 0.7, P.metal, 0, 3.0, -0.4)
      break
    case 'desk':
      B(4, 0.2, 2, P.wood, 0, 2.4, 0); B(0.18, 2.4, 2, P.wood, -1.9, 1.2, 0); B(0.18, 2.4, 2, P.wood, 1.9, 1.2, 0)
      break
    case 'bookshelf':
      B(3, 6, 1, P.wood, 0, 3, 0)
      for (const sy of [1.2, 2.4, 3.6, 4.8]) B(2.7, 0.12, 0.85, P.dark, 0, sy, 0)
      break
    case 'plant': {
      Cy(0.55, 1.0, P.dark, 0, 0.5, 0)
      const s = new THREE.Mesh(new THREE.SphereGeometry(1.05, 14, 12), P.leaf); s.position.set(0, 1.9, 0); s.castShadow = true; g.add(s)
      const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.75, 12, 10), P.leaf); s2.position.set(0.5, 2.5, 0.2); s2.castShadow = true; g.add(s2)
      break
    }
    case 'lamp': {
      Cy(0.5, 0.12, P.dark, 0, 0.06, 0); Cy(0.06, 4.6, P.metal, 0, 2.3, 0)
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.1, 20, 1, true), P.shade)
      shade.position.set(0, 4.9, 0); g.add(shade)
      break
    }
    case 'chair':
      B(1.6, 0.2, 1.6, P.wood, 0, 1.5, 0); B(1.6, 1.6, 0.2, P.wood, 0, 2.3, -0.7)
      for (const lx of [-0.6, 0.6]) for (const lz of [-0.6, 0.6]) B(0.16, 1.5, 0.16, P.wood, lx, 0.75, lz)
      break
    default:
      B(2, 2, 2, P.wood, 0, 1, 0)
  }
  const fp = footprint(kind)
  g.userData.footprint = [fp.w, fp.d]
  return g
}

export default function Blueprint3D({ floors, mode, storeKey, startWalk, initialFurniture }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [colors, setColors] = useState({ wall: '#EDE8DD', floor: '#26303F', accent: '#AF8C56', water: '#3FA7C4' })
  const [walk, setWalk] = useState(!!startWalk)
  const [recording, setRecording] = useState(false)
  const recordRef = useRef<(() => void) | null>(null)
  const [locked, setLocked] = useState(false)
  const [furnishing, setFurnishing] = useState(false)
  const [room, setRoom] = useState('Living')
  const [placeFloor, setPlaceFloor] = useState(0)
  const skey = storeKey ? `nalu-furnish-${storeKey}` : ''
  const [furniture, setFurniture] = useState<FurnItem[]>(() => {
    if (skey) {
      try { const saved = localStorage.getItem(skey); if (saved !== null) { const s = JSON.parse(saved); if (Array.isArray(s)) return s } } catch { /* */ }
    }
    return initialFurniture && initialFurniture.length ? initialFurniture : []
  })
  const [selected, setSelected] = useState<string | null>(null)

  // refs shared between the structural effect and the furniture effect
  const rootRef = useRef<THREE.Group | null>(null)
  const furnGroupRef = useRef<THREE.Group | null>(null)
  const camStateRef = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null)
  const furnitureRef = useRef(furniture); furnitureRef.current = furniture
  const selectedRef = useRef(selected); selectedRef.current = selected
  const furnishRef = useRef(furnishing); furnishRef.current = furnishing
  const palRef = useRef<Pal | null>(null)
  // Color-bearing building materials, so colour edits update IN PLACE instead of
  // tearing down and rebuilding the whole WebGL renderer on every picker change.
  const matsRef = useRef<Record<'wall' | 'inner' | 'slab' | 'trim' | 'water' | 'build', THREE.MeshStandardMaterial> | null>(null)

  const list = (floors || []).filter((f) => f && Array.isArray(f.shapes) && f.shapes.length)
  const vbw = Math.max(40, ...list.map((f) => f.viewBox?.w || 40))
  const vbh = Math.max(28, ...list.map((f) => f.viewBox?.h || 28))
  const floorY = (i: number) => (mode === 'building' ? i * STOREY : 0)

  useEffect(() => { if (skey) try { localStorage.setItem(skey, JSON.stringify(furniture)) } catch { /* ignore */ } }, [furniture, skey])

  // ---- structural scene (building + walls) ----
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !list.length) return
    const span = Math.max(vbw, vbh)
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true }) } catch { return }
    const w = mount.clientWidth || 640
    const h = mount.clientHeight || 480
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0c0e14)
    const camera = new THREE.PerspectiveCamera(walk ? 72 : 45, w / h, 0.05, 6000)
    const cx = vbw / 2, cz = vbh / 2
    const totalH = mode === 'building' ? STOREY * list.length : WALL_H

    scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x20262e, 1.0))
    const sun = new THREE.DirectionalLight(0xfff4e2, 1.4)
    sun.position.set(span * 0.7, span * 1.4 + totalH, span * 0.5)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const sc = sun.shadow.camera as THREE.OrthographicCamera
    sc.left = -span; sc.right = span; sc.top = span * 1.4; sc.bottom = -span; sc.near = 0.1; sc.far = span * 7
    scene.add(sun)

    const root = new THREE.Group()
    root.position.set(-cx, 0, -cz)
    scene.add(root)
    rootRef.current = root
    const furnGroup = new THREE.Group()
    root.add(furnGroup)
    furnGroupRef.current = furnGroup

    const wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.wall), roughness: 0.9 })
    const innerMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.wall).multiplyScalar(0.96), roughness: 0.92 })
    const slabMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.floor), roughness: 0.96 })
    const trimMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.accent), roughness: 0.5, metalness: 0.35 })
    const waterMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.water), roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.8 })
    const furnMat = new THREE.MeshStandardMaterial({ color: 0x9a8a72, roughness: 0.82 })
    const buildMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.wall).multiplyScalar(0.92), roughness: 0.75 })
    const hardMat = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.95 })
    matsRef.current = { wall: wallMat, inner: innerMat, slab: slabMat, trim: trimMat, water: waterMat, build: buildMat }

    // Door openings: each floor's doors become "cut" spans; axis-aligned walls
    // are split around them (with a header above door height), so the
    // first-person walkthrough can genuinely WALK between rooms through the
    // doorways instead of facing solid boxes.
    const DOOR_H = 7
    let cutH: Array<{ z: number; from: number; to: number }> = [] // doors in horizontal walls
    let cutV: Array<{ x: number; from: number; to: number }> = [] // doors in vertical walls
    // Ground-floor wall footprints (for walk-mode collision).
    const solids: Array<{ x1: number; z1: number; x2: number; z2: number }> = []
    const wallSeg = (ax: number, az: number, bx: number, bz: number, y0: number, t: number, m: THREE.Material, yBase = 0, hgt = WALL_H) => {
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz)
      if (len < 0.1) return
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len + t, hgt, t), m)
      mesh.castShadow = true; mesh.receiveShadow = true
      mesh.position.set((ax + bx) / 2, y0 + yBase + hgt / 2, (az + bz) / 2)
      mesh.rotation.y = -Math.atan2(dz, dx)
      root.add(mesh)
      // full-height ground-floor walls block the walker
      if (y0 === 0 && yBase === 0) {
        solids.push({
          x1: Math.min(ax, bx) - t / 2, z1: Math.min(az, bz) - t / 2,
          x2: Math.max(ax, bx) + t / 2, z2: Math.max(az, bz) + t / 2,
        })
      }
    }
    const wall = (ax: number, az: number, bx: number, bz: number, y0: number, t: number, m: THREE.Material) => {
      // Horizontal wall: split around any door spans on this line.
      if (Math.abs(az - bz) < 0.01) {
        const z = az
        const x1 = Math.min(ax, bx), x2 = Math.max(ax, bx)
        const cuts = cutH.filter((c) => Math.abs(c.z - z) < 0.9 && c.to > x1 + 0.05 && c.from < x2 - 0.05).sort((a, b) => a.from - b.from)
        if (cuts.length) {
          let cur = x1
          for (const c of cuts) {
            if (c.from > cur + 0.1) wallSeg(cur, z, Math.min(c.from, x2), z, y0, t, m)
            // header above the opening keeps the wall reading as one plane
            wallSeg(Math.max(c.from, x1), z, Math.min(c.to, x2), z, y0, t, m, DOOR_H, WALL_H - DOOR_H)
            cur = Math.max(cur, c.to)
          }
          if (cur < x2 - 0.1) wallSeg(cur, z, x2, z, y0, t, m)
          return
        }
      } else if (Math.abs(ax - bx) < 0.01) {
        const x = ax
        const z1 = Math.min(az, bz), z2 = Math.max(az, bz)
        const cuts = cutV.filter((c) => Math.abs(c.x - x) < 0.9 && c.to > z1 + 0.05 && c.from < z2 - 0.05).sort((a, b) => a.from - b.from)
        if (cuts.length) {
          let cur = z1
          for (const c of cuts) {
            if (c.from > cur + 0.1) wallSeg(x, cur, x, Math.min(c.from, z2), y0, t, m)
            wallSeg(x, Math.max(c.from, z1), x, Math.min(c.to, z2), y0, t, m, DOOR_H, WALL_H - DOOR_H)
            cur = Math.max(cur, c.to)
          }
          if (cur < z2 - 0.1) wallSeg(x, cur, x, z2, y0, t, m)
          return
        }
      }
      wallSeg(ax, az, bx, bz, y0, t, m)
    }
    const perimeter = (x: number, y: number, rw: number, rh: number, y0: number) => {
      wall(x, y, x + rw, y, y0, WALL_T, wallMat); wall(x, y + rh, x + rw, y + rh, y0, WALL_T, wallMat)
      wall(x, y, x, y + rh, y0, WALL_T, wallMat); wall(x + rw, y, x + rw, y + rh, y0, WALL_T, wallMat)
    }
    const innerWalls = (x: number, y: number, rw: number, rh: number, y0: number) => {
      wall(x, y, x + rw, y, y0, INNER_T, innerMat); wall(x, y + rh, x + rw, y + rh, y0, INNER_T, innerMat)
      wall(x, y, x, y + rh, y0, INNER_T, innerMat); wall(x + rw, y, x + rw, y + rh, y0, INNER_T, innerMat)
    }
    const block = (x: number, y: number, rw: number, rh: number, yPos: number, hgt: number, m: THREE.Material, shadow = true) => {
      if (rw < 0.1 || rh < 0.1 || hgt < 0.01) return
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(rw, hgt, rh), m)
      mesh.position.set(x + rw / 2, yPos + hgt / 2, y + rh / 2)
      if (shadow) { mesh.castShadow = true; mesh.receiveShadow = true } else mesh.receiveShadow = true
      root.add(mesh)
    }
    const extentOf = (f: Floor) => {
      const rects = (f.shapes || []).filter((s) => s?.type === 'rect')
      let big: Shape | null = null, bigA = 0
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
      for (const r of rects) {
        const a = num(r.w) * num(r.h)
        if (a > bigA) { bigA = a; big = r }
        minx = Math.min(minx, num(r.x)); miny = Math.min(miny, num(r.y))
        maxx = Math.max(maxx, num(r.x) + num(r.w)); maxy = Math.max(maxy, num(r.y) + num(r.h))
      }
      const fw = f.viewBox?.w || vbw, fh = f.viewBox?.h || vbh
      if (!isFinite(minx)) { minx = 0; miny = 0; maxx = fw; maxy = fh }
      return { x: minx, y: miny, w: maxx - minx, h: maxy - miny, big }
    }
    const renderFloor = (f: Floor, y0: number, site: boolean) => {
      const ext = extentOf(f)
      const floorArea = Math.max(1, ext.w * ext.h)
      // Collect this floor's door openings BEFORE any wall is drawn.
      cutH = []; cutV = []
      if (!site) {
        for (const s of f.shapes || []) {
          if (s?.type !== 'door') continue
          const dx0 = num(s.x), dy0 = num(s.y), dw = Math.max(2.4, num(s.w, 3))
          const pad = 0.35
          if ((s as { dir?: string }).dir === 'v') cutV.push({ x: dx0, from: dy0 - pad, to: dy0 + dw + pad })
          else cutH.push({ z: dy0, from: dx0 - pad, to: dx0 + dw + pad })
        }
      }
      if (!site) perimeter(ext.x, ext.y, ext.w, ext.h, y0)
      for (const s of f.shapes || []) {
        const t = s?.type, label = lc(s?.label)
        if (t === 'rect') {
          const x = num(s.x), y = num(s.y), rw = num(s.w), rh = num(s.h), area = rw * rh
          const isExt = s === ext.big && area >= floorArea * 0.7
          if (site) {
            const coversLot = rw >= (f.viewBox?.w || vbw) * 0.82 && rh >= (f.viewBox?.h || vbh) * 0.82
            if (coversLot && /(propert|lot|boundary|line)/.test(label)) continue
            if (isBuilding(label) || area >= floorArea * 0.06) block(x, y, rw, rh, 0.04, WALL_H * 2.1, buildMat)
            else if (isHardscape(label)) block(x, y, rw, rh, 0.02, 0.08, hardMat, false)
            else block(x, y, rw, rh, 0.02, 0.06, slabMat, false)
          } else if (isExt) {
            continue
          } else if (isFixture(label)) {
            const low = /toilet|tub|bath|shower|sink|island|counter|sofa|couch|desk|table|nightstand|rug|stair/.test(label)
            block(x, y, rw, rh, y0 + 0.03, low ? WALL_H * 0.24 : WALL_H * 0.36, /rug/.test(label) ? trimMat : furnMat, !/rug/.test(label))
          } else if (area >= floorArea * 0.02) {
            innerWalls(x, y, rw, rh, y0)
          }
        } else if (t === 'line' && !site) {
          wall(num(s.x1), num(s.y1), num(s.x2), num(s.y2), y0, INNER_T, innerMat)
        } else if (t === 'polyline' && Array.isArray(s.points) && !site) {
          for (let i = 0; i + 1 < s.points.length; i++)
            wall(num(s.points[i][0]), num(s.points[i][1]), num(s.points[i + 1][0]), num(s.points[i + 1][1]), y0, INNER_T, innerMat)
        } else if (t === 'ellipse') {
          const cyl = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.4, 40), waterMat)
          cyl.scale.set(num(s.rx, 2), 1, num(s.ry, 2)); cyl.position.set(num(s.cx), y0 + 0.05, num(s.cy)); cyl.receiveShadow = true; root.add(cyl)
        } else if (t === 'tree') {
          const r = num(s.r, 2)
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.12, r * 0.16, WALL_H * 0.7, 8), new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 }))
          trunk.position.set(num(s.cx), y0 + WALL_H * 0.35, num(s.cy)); trunk.castShadow = true; root.add(trunk)
          const fol = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshStandardMaterial({ color: 0x3f6b3a, roughness: 0.9 }))
          fol.position.set(num(s.cx), y0 + WALL_H * 0.7 + r * 0.7, num(s.cy)); fol.castShadow = true; root.add(fol)
        } else if (t === 'window' && !site) {
          const x = num(s.x), y = num(s.y), ww = num(s.w, 1)
          // dir:"v" = the opening sits in a vertical (side) wall → the glass
          // runs along Z instead of X, so side-wall windows aren't rotated 90°.
          const vert = (s as { dir?: string }).dir === 'v'
          const glass = new THREE.Mesh(
            new THREE.BoxGeometry(vert ? WALL_T * 0.35 : ww * 0.85, WALL_H * 0.36, vert ? ww * 0.85 : WALL_T * 0.35),
            new THREE.MeshStandardMaterial({ color: 0x9fd0ff, roughness: 0.08, transparent: true, opacity: 0.45 }),
          )
          glass.position.set(vert ? x : x + ww / 2, y0 + WALL_H * 0.55, vert ? y + ww / 2 : y); root.add(glass)
        } else if (t === 'door' && !site) {
          const x = num(s.x), y = num(s.y), dw = num(s.w, 1)
          const vert = (s as { dir?: string }).dir === 'v'
          if (vert) block(x - (WALL_T * 1.3) / 2, y, WALL_T * 1.3, dw, y0 + 0.02, 0.08, trimMat, false)
          else block(x, y, dw, WALL_T * 1.3, y0 + 0.02, 0.08, trimMat, false)
        }
      }
    }

    if (mode === 'site') {
      const ground = new THREE.Mesh(new THREE.BoxGeometry(vbw + 2, 0.2, vbh + 2), new THREE.MeshStandardMaterial({ color: 0x2c3a2a, roughness: 1 }))
      ground.position.set(cx, -0.1, cz); ground.receiveShadow = true; root.add(ground)
      renderFloor(list[0], 0, true)
    } else {
      // Each storey gets a floor slab UNDER it; NO roof on top so it reads as an
      // open floor plan — you see down into the rooms from the orbit view.
      list.forEach((f, i) => {
        const y0 = i * STOREY
        block(-0.4, -0.4, vbw + 0.8, vbh + 0.8, y0 - SLAB, SLAB, slabMat, false)
        renderFloor(f, y0, false)
      })
    }

    if (!walk) {
      const grid = new THREE.GridHelper(span * 1.6, Math.round(span * 1.6), 0x2a3140, 0x171b22)
      grid.position.set(cx, -0.12, cz); root.add(grid)
    }

    // furniture palette materials (used by the furniture effect)
    palRef.current = {
      wood: new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.7 }),
      fabric: new THREE.MeshStandardMaterial({ color: 0x6f7b8c, roughness: 0.95 }),
      fabric2: new THREE.MeshStandardMaterial({ color: 0x8794a4, roughness: 0.95 }),
      metal: new THREE.MeshStandardMaterial({ color: 0xc7ccd2, roughness: 0.35, metalness: 0.7 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.7 }),
      black: new THREE.MeshStandardMaterial({ color: 0x121418, roughness: 0.5 }),
      screen: new THREE.MeshStandardMaterial({ color: 0x16344a, roughness: 0.2, emissive: new THREE.Color(0x0a2233), emissiveIntensity: 0.4 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.85 }),
      marble: new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.25, metalness: 0.1 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0x3f7d46, roughness: 0.9 }),
      shade: new THREE.MeshStandardMaterial({ color: 0xf3e6c4, roughness: 0.6, emissive: new THREE.Color(0x4a3c1a), emissiveIntensity: 0.5, side: THREE.DoubleSide }),
      accent: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.accent), roughness: 0.7 }),
    }

    // ---- controls ----
    let orbit: OrbitControls | null = null
    let plc: PointerLockControls | null = null
    const keys: Record<string, boolean> = {}
    const ray = new THREE.Raycaster()
    let dragging: string | null = null
    let downXY = { x: 0, y: 0 }
    let moved = false

    const ndc = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect()
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    }
    const fidOf = (o: THREE.Object3D | null): string | null => {
      let p: THREE.Object3D | null = o
      while (p) { if (p.userData && p.userData.fid) return p.userData.fid as string; p = p.parent }
      return null
    }
    const planeAt = (y: number) => new THREE.Plane(new THREE.Vector3(0, 1, 0), -y)

    const onDown = (e: PointerEvent) => {
      if (walk || !furnishRef.current) return
      ray.setFromCamera(ndc(e), camera)
      const hits = ray.intersectObjects(furnGroup.children, true)
      const fid = hits.length ? fidOf(hits[0].object) : null
      downXY = { x: e.clientX, y: e.clientY }; moved = false
      if (fid) {
        dragging = fid
        setSelected(fid)
        if (orbit) orbit.enabled = false
        try { renderer.domElement.setPointerCapture(e.pointerId) } catch { /* */ }
      }
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging) return
      if (Math.abs(e.clientX - downXY.x) + Math.abs(e.clientY - downXY.y) > 3) moved = true
      const item = furnitureRef.current.find((f) => f.id === dragging)
      if (!item) return
      ray.setFromCamera(ndc(e), camera)
      const hit = new THREE.Vector3()
      if (ray.ray.intersectPlane(planeAt(floorY(item.floor)), hit)) {
        const nx = Math.max(0, Math.min(vbw, hit.x + cx))
        const nz = Math.max(0, Math.min(vbh, hit.z + cz))
        const mesh = furnGroup.children.find((c) => c.userData.fid === dragging)
        if (mesh) mesh.position.set(nx, floorY(item.floor), nz)
        item.x = nx; item.z = nz // mutate live; commit on up
      }
    }
    const onUp = (e: PointerEvent) => {
      if (orbit) orbit.enabled = true
      if (dragging) {
        const d = dragging; dragging = null
        try { renderer.domElement.releasePointerCapture(e.pointerId) } catch { /* */ }
        if (moved) setFurniture((arr) => [...arr]) // commit mutated x/z
        return
      }
      if (!walk && furnishRef.current && !moved) {
        ray.setFromCamera(ndc(e), camera)
        const hits = ray.intersectObjects(furnGroup.children, true)
        setSelected(hits.length ? fidOf(hits[0].object) : null)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.code] = true
      if (!walk && furnishRef.current && selectedRef.current) {
        if (e.code === 'KeyR') { e.preventDefault(); const id = selectedRef.current; setFurniture((arr) => arr.map((f) => f.id === id ? { ...f, rot: f.rot + Math.PI / 12 } : f)) }
        if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); const id = selectedRef.current; setFurniture((arr) => arr.filter((f) => f.id !== id)); setSelected(null) }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => { keys[e.code] = false }

    let lockClick: (() => void) | null = null
    if (walk) {
      camera.position.set(0, EYE, cz * 0.5)
      plc = new PointerLockControls(camera, renderer.domElement)
      plc.addEventListener('lock', () => setLocked(true))
      plc.addEventListener('unlock', () => setLocked(false))
      lockClick = () => plc && plc.lock()
      renderer.domElement.addEventListener('click', lockClick)
    } else {
      orbit = new OrbitControls(camera, renderer.domElement)
      orbit.enableDamping = true
      if (camStateRef.current) {
        camera.position.copy(camStateRef.current.pos)
        orbit.target.copy(camStateRef.current.target)
      } else {
        camera.position.set(span * 0.72, span * 0.6 + totalH, span * 0.85)
        orbit.target.set(0, totalH * 0.4, 0)
      }
      renderer.domElement.addEventListener('pointerdown', onDown)
      renderer.domElement.addEventListener('pointermove', onMove)
      renderer.domElement.addEventListener('pointerup', onUp)

      // Record a ~14s auto-orbit tour of the room → downloadable .webm video.
      recordRef.current = () => {
        const o = orbit
        if (!o || typeof (renderer.domElement as HTMLCanvasElement).captureStream !== 'function') return
        let mime = 'video/webm;codecs=vp9'
        if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mime)) mime = 'video/webm'
        let rec: MediaRecorder
        try {
          rec = new MediaRecorder((renderer.domElement as HTMLCanvasElement).captureStream(30), { mimeType: mime, videoBitsPerSecond: 6_000_000 })
        } catch { return }
        const chunks: Blob[] = []
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
        rec.onstop = () => {
          o.autoRotate = false
          setRecording(false)
          const blob = new Blob(chunks, { type: 'video/webm' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = 'nalu-room-tour.webm'
          document.body.appendChild(a); a.click(); a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 5000)
        }
        o.autoRotate = true
        o.autoRotateSpeed = 1.6
        setRecording(true)
        rec.start()
        setTimeout(() => { if (rec.state !== 'inactive') rec.stop() }, 14_000)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    let raf = 0, prev = 0
    const animate = (now?: number) => {
      raf = requestAnimationFrame(animate)
      const t = now || 0
      const dt = prev ? Math.min(0.05, (t - prev) / 1000) : 0.016
      prev = t
      if (orbit) orbit.update()
      if (plc && plc.isLocked) {
        const beforeX = camera.position.x, beforeZ = camera.position.z
        const sp = 14 * dt
        if (keys['KeyW'] || keys['ArrowUp']) plc.moveForward(sp)
        if (keys['KeyS'] || keys['ArrowDown']) plc.moveForward(-sp)
        if (keys['KeyA'] || keys['ArrowLeft']) plc.moveRight(-sp)
        if (keys['KeyD'] || keys['ArrowRight']) plc.moveRight(sp)
        camera.position.y = EYE
        // Wall collision: slide along walls, walk through DOORWAYS only.
        const R = 0.45
        for (const b of solids) {
          const p = camera.position
          if (p.x > b.x1 - R && p.x < b.x2 + R && p.z > b.z1 - R && p.z < b.z2 + R) {
            const wasOutX = beforeX <= b.x1 - R || beforeX >= b.x2 + R
            const wasOutZ = beforeZ <= b.z1 - R || beforeZ >= b.z2 + R
            if (wasOutX && !wasOutZ) p.x = beforeX
            else if (wasOutZ && !wasOutX) p.z = beforeZ
            else if (wasOutX && wasOutZ) { p.x = beforeX; p.z = beforeZ }
          }
        }
      }
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      if (!mount.clientWidth) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', onResize)

    return () => {
      recordRef.current = null
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      if (orbit) { camStateRef.current = { pos: camera.position.clone(), target: orbit.target.clone() }; orbit.dispose() }
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      if (lockClick) renderer.domElement.removeEventListener('click', lockClick)
      plc?.dispose()
      scene.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() })
      // Explicitly release the WebGL context (dispose() alone leaks it) — without
      // this, repeated rebuilds exhaust the browser's ~16-context limit and the
      // 3D view stops rendering ("breaks").
      try { renderer.forceContextLoss() } catch { /* */ }
      renderer.dispose()
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
      rootRef.current = null; furnGroupRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floors, mode, walk])

  // Apply colour edits in place — no renderer rebuild (prevents context churn).
  useEffect(() => {
    const m = matsRef.current
    if (!m) return
    m.wall.color.set(colors.wall)
    m.inner.color.set(new THREE.Color(colors.wall).multiplyScalar(0.96))
    m.slab.color.set(colors.floor)
    m.trim.color.set(colors.accent)
    m.water.color.set(colors.water)
    m.build.color.set(new THREE.Color(colors.wall).multiplyScalar(0.92))
    if (palRef.current) palRef.current.accent.color.set(colors.accent)
  }, [colors])

  // ---- furniture (re-rendered without rebuilding the building) ----
  useEffect(() => {
    const fg = furnGroupRef.current, P = palRef.current
    if (!fg || !P) return
    while (fg.children.length) { const c = fg.children[0]; fg.remove(c); (c as THREE.Mesh).geometry?.dispose?.() }
    for (const it of furniture) {
      const g = makeFurniture(it.kind, P)
      g.position.set(it.x, floorY(it.floor), it.z)
      g.rotation.y = it.rot
      g.traverse((o) => { o.userData.fid = it.id })
      if (it.id === selected && !walk) {
        const [fw, fd] = (g.userData.footprint as number[]) || [3, 3]
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(fw, fd) * 0.62, Math.max(fw, fd) * 0.62 + 0.35, 40),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.accent), side: THREE.DoubleSide, transparent: true, opacity: 0.95 }),
        )
        ring.rotation.x = -Math.PI / 2
        ring.position.y = 0.06
        g.add(ring)
      }
      fg.add(g)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [furniture, selected, walk, colors])

  const addItem = (kind: string) => {
    const id = `f${Date.now().toString(36)}${furniture.length}`
    const jitter = (furniture.length % 5) * 2.2
    setFurniture((arr) => [...arr, { id, kind, x: vbw / 2 + jitter, z: vbh / 2 + jitter, rot: 0, floor: placeFloor }])
    setSelected(id)
    if (!furnishing) setFurnishing(true)
  }
  const sel = furniture.find((f) => f.id === selected)

  return (
    <div className="relative">
      <div ref={mountRef} className="h-[34rem] w-full cursor-grab bg-canvas" />

      {/* top toolbar */}
      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2 rounded-lg border border-glass/[0.12] bg-black/55 px-2.5 py-2 backdrop-blur">
        <button onClick={() => { setWalk((wk) => !wk); setFurnishing(false); setSelected(null) }}
          className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${walk ? 'bg-amber-500/30 text-amber-100' : 'bg-glass/10 text-ink hover:bg-glass/20'}`}>
          {walk ? 'Orbit view' : 'Walk through'}
        </button>
        {!walk && (
          <button onClick={() => { setFurnishing((f) => !f); setSelected(null) }}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${furnishing ? 'bg-emerald-500/30 text-emerald-100' : 'bg-glass/10 text-ink hover:bg-glass/20'}`}>
            {furnishing ? 'Done' : 'Furnish'}
          </button>
        )}
        {!walk && !furnishing && (
          <button onClick={() => recordRef.current?.()} disabled={recording}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${recording ? 'bg-red-500/30 text-red-100' : 'bg-glass/10 text-ink hover:bg-glass/20'} disabled:opacity-70`}>
            {recording ? 'Recording…' : 'Record tour'}
          </button>
        )}
        {!furnishing && (['wall', 'floor', 'accent', 'water'] as const).map((k) => (
          <label key={k} className="flex items-center gap-1 text-[10px] capitalize text-ink">
            <input type="color" value={colors[k]} onChange={(e) => setColors((c) => ({ ...c, [k]: e.target.value }))}
              className="h-5 w-6 cursor-pointer rounded border border-glass/20 bg-transparent" />
            {k}
          </label>
        ))}
        {mode === 'building' && list.length > 1 && furnishing && (
          <select value={placeFloor} onChange={(e) => setPlaceFloor(Number(e.target.value))}
            className="rounded-md bg-glass/10 px-1.5 py-1 text-[11px] text-ink outline-none">
            {list.map((f, i) => <option key={i} value={i} className="bg-panel2">{f.name || `Level ${i + 1}`}</option>)}
          </select>
        )}
      </div>

      {/* furniture palette */}
      {furnishing && !walk && (
        <div className="absolute right-3 top-3 max-h-[31rem] w-44 overflow-auto rounded-lg border border-glass/[0.12] bg-black/65 p-2 backdrop-blur">
          <div className="mb-1.5 flex flex-wrap gap-1">
            {ROOMS.map((r) => (
              <button key={r} onClick={() => setRoom(r)}
                className={`rounded px-1.5 py-0.5 text-[9px] ${room === r ? 'bg-emerald-500/30 text-emerald-100' : 'bg-glass/10 text-dim hover:bg-glass/20'}`}>{r}</button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {CATALOG.filter((c) => c.room === room).map((c) => (
              <button key={c.kind} onClick={() => addItem(c.kind)}
                className="rounded bg-glass/[0.06] px-2 py-1.5 text-left text-[10px] text-ink hover:bg-glass/15">+ {c.label}</button>
            ))}
          </div>
          {sel && (
            <div className="mt-2 rounded border border-glass/10 bg-glass/[0.04] p-1.5">
              <div className="mb-1 text-[9px] uppercase tracking-wide text-dim">Selected · {footprint(sel.kind) && CATALOG.find((c) => c.kind === sel.kind)?.label}</div>
              <div className="flex gap-1">
                <button onClick={() => setFurniture((arr) => arr.map((f) => f.id === sel.id ? { ...f, rot: f.rot + Math.PI / 8 } : f))}
                  className="flex-1 rounded bg-glass/10 px-2 py-1 text-[10px] text-ink hover:bg-glass/20">Rotate</button>
                <button onClick={() => { setFurniture((arr) => arr.filter((f) => f.id !== sel.id)); setSelected(null) }}
                  className="flex-1 rounded bg-red-500/20 px-2 py-1 text-[10px] text-red-200 hover:bg-red-500/30">Delete</button>
              </div>
            </div>
          )}
          {furniture.length > 0 && (
            <button onClick={() => { setFurniture([]); setSelected(null) }}
              className="mt-1.5 w-full rounded bg-glass/[0.04] px-2 py-1 text-[9px] text-dim hover:bg-glass/10">Clear all ({furniture.length})</button>
          )}
          <div className="mt-1.5 text-[9px] leading-tight text-dim">Drag to place · R rotates · Del removes</div>
        </div>
      )}

      {/* walk overlay */}
      {walk && !locked && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl border border-glass/15 bg-black/65 px-5 py-4 text-center backdrop-blur">
            <div className="text-sm font-medium text-ink">Click to walk through</div>
            <div className="mt-1 text-[11px] text-dim">WASD / arrows to move · mouse to look · Esc to exit</div>
          </div>
        </div>
      )}
      {!walk && !furnishing && (
        <div className="absolute bottom-3 right-3 rounded-md bg-black/50 px-2 py-1 text-[10px] text-dim backdrop-blur">drag to orbit · scroll to zoom</div>
      )}
    </div>
  )
}
