import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { Box, Download, Loader2, Code2 } from 'lucide-react'

// Inline "Nalu CAD" card: AI OpenSCAD → STL compiled in-browser (openscad-wasm)
// → live studio-lit 3D viewer. Captures compile errors and self-repairs via the
// backend until the model renders. Download .stl / .scad.

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength)
  new Uint8Array(ab).set(u8)
  return ab
}

// Compile in a Web Worker so the heavy CGAL pass never blocks the UI thread, and
// so a runaway model can be HARD-killed on timeout (the main thread cannot
// interrupt a synchronous wasm callMain). A fresh worker per compile = clean state.
function compileScadToStl(code: string, timeoutMs = 30000): Promise<{ stl?: Uint8Array; error?: string }> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./openscadWorker.ts', import.meta.url), { type: 'module' })
    } catch (e) {
      resolve({ error: e instanceof Error ? e.message : 'worker failed to start' })
      return
    }
    let done = false
    const finish = (r: { stl?: Uint8Array; error?: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.terminate()
      resolve(r)
    }
    const timer = setTimeout(() => finish({ error: 'compile timed out' }), timeoutMs)
    worker.onmessage = (ev: MessageEvent<{ stl?: Uint8Array; error?: string }>) => finish(ev.data || {})
    worker.onerror = (ev) => finish({ error: ev.message || 'worker error' })
    worker.postMessage({ code })
  })
}

type Three = {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  controls: OrbitControls
  requestRender: () => void
  dispose: () => void
}

function initThree(mount: HTMLDivElement): Three {
  const w = mount.clientWidth || 600
  const h = mount.clientHeight || 340
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0c0e14)
  const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100000)
  camera.position.set(80, 80, 80)
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  mount.appendChild(renderer.domElement)

  // Studio environment for realistic reflections — guarded: if PMREM/env fails
  // on this GPU, fall back to plain lighting instead of breaking the whole card.
  let pmrem: THREE.PMREMGenerator | null = null
  let envRT: { texture: THREE.Texture; dispose: () => void } | null = null
  try {
    pmrem = new THREE.PMREMGenerator(renderer)
    envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
    scene.environment = envRT.texture
  } catch {
    pmrem = null
    envRT = null
  }

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x202830, 0.6))
  const key = new THREE.DirectionalLight(0xffffff, 1.3)
  key.position.set(1, 1.6, 1)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.5)
  fill.position.set(-1, -0.4, -1)
  scene.add(fill)
  const grid = new THREE.GridHelper(400, 40, 0x2a2f3a, 0x171b22)
  ;(grid.material as THREE.Material).opacity = 0.5
  ;(grid.material as THREE.Material).transparent = true
  scene.add(grid)

  // Render ON DEMAND only (no constant GPU redraw): render when the user
  // interacts, when a model loads, while damping settles, and only while the
  // card is actually on-screen. This stops CAD from slowing the whole site.
  let raf = 0
  let visible = true
  let needsRender = true
  const requestRender = () => {
    needsRender = true
  }
  controls.addEventListener('change', requestRender)
  const io = new IntersectionObserver(
    (entries) => {
      visible = entries[0]?.isIntersecting ?? true
      if (visible) requestRender()
    },
    { threshold: 0.01 },
  )
  io.observe(mount)
  const onResize = () => {
    if (!mount.clientWidth) return
    camera.aspect = mount.clientWidth / mount.clientHeight
    camera.updateProjectionMatrix()
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    requestRender()
  }
  window.addEventListener('resize', onResize)
  const animate = () => {
    raf = requestAnimationFrame(animate)
    if (!visible) return
    const moving = controls.update() // true while damping is still settling
    if (needsRender || moving) {
      renderer.render(scene, camera)
      needsRender = false
    }
  }
  animate()
  return {
    scene,
    camera,
    renderer,
    controls,
    requestRender,
    dispose: () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      controls.removeEventListener('change', requestRender)
      window.removeEventListener('resize', onResize)
      envRT?.dispose()
      pmrem?.dispose()
      renderer.dispose()
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    },
  }
}

type Status = 'compiling' | 'repairing' | 'done' | 'error'

export default function CADCard({ code }: { code: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const threeRef = useRef<Three | null>(null)
  const meshRef = useRef<THREE.Mesh | null>(null)
  const [stl, setStl] = useState<Uint8Array | null>(null)
  const [activeCode, setActiveCode] = useState(code)
  const [status, setStatus] = useState<Status>('compiling')
  const [error, setError] = useState('')
  const [showCode, setShowCode] = useState(false)

  useEffect(() => {
    if (!mountRef.current) return
    let t: Three | null = null
    try {
      t = initThree(mountRef.current)
      threeRef.current = t
    } catch {
      // WebGL unavailable — the model still compiles + downloads, just no preview.
    }
    return () => t?.dispose()
  }, [])

  const showStl = (bytes: Uint8Array) => {
    const t = threeRef.current
    if (!t) return
    if (meshRef.current) {
      t.scene.remove(meshRef.current)
      meshRef.current.geometry.dispose()
      ;(meshRef.current.material as THREE.Material).dispose()
    }
    const geo = new STLLoader().parse(toArrayBuffer(bytes))
    geo.computeVertexNormals()
    geo.center()
    geo.computeBoundingSphere()
    const r = geo.boundingSphere?.radius || 50
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xa9c2e6, metalness: 0.55, roughness: 0.32, envMapIntensity: 1.0 }),
    )
    t.scene.add(mesh)
    meshRef.current = mesh
    t.camera.position.set(r * 1.9, r * 1.5, r * 1.9)
    t.controls.target.set(0, 0, 0)
    t.controls.update()
    t.requestRender()
  }

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setStatus('compiling')
      setError('')
      setStl(null)
      let curCode = code
      for (let attempt = 0; attempt < 3; attempt++) {
        let result: { stl?: Uint8Array; error?: string }
        try {
          result = await compileScadToStl(curCode)
        } catch (e) {
          result = { error: e instanceof Error ? e.message : 'compile failed' }
        }
        if (cancelled) return
        if (result.stl) {
          showStl(result.stl)
          setStl(result.stl)
          setActiveCode(curCode)
          setStatus('done')
          return
        }
        // Self-repair: ask the backend to fix the failing code, then recompile.
        if (attempt < 2) {
          setStatus('repairing')
          try {
            const r = await fetch('/api/cad', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: curCode, error: result.error }),
            })
            const d = (await r.json().catch(() => ({}))) as { code?: string }
            if (cancelled) return
            if (d.code) {
              curCode = d.code
              continue
            }
          } catch {
            /* fall through to error */
          }
        }
        setActiveCode(curCode)
        setError(result.error || 'Could not compile this model.')
        setStatus('error')
        return
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  const dl = (data: BlobPart, filename: string, type: string) => {
    const url = URL.createObjectURL(new Blob([data], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-white/[0.16] bg-white/[0.04]">
      <div className="flex items-center gap-2.5 border-b border-white/[0.12] px-4 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/15 text-blue-300">
          <Box size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[#ededed]">Nalu CAD</div>
          <div className="text-xs text-[#8e8e8e]">
            {status === 'compiling'
              ? 'Building 3D model…'
              : status === 'repairing'
                ? 'Refining the model…'
                : status === 'error'
                  ? 'Preview unavailable'
                  : 'Drag to orbit · scroll to zoom'}
          </div>
        </div>
        <button
          onClick={() => setShowCode((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-xs text-[#ededed] hover:bg-white/[0.12]"
        >
          <Code2 size={13} /> Code
        </button>
        {stl && (
          <button
            onClick={() => dl(toArrayBuffer(stl), 'nalu-model.stl', 'model/stl')}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500/20 px-2.5 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30"
          >
            <Download size={13} /> STL
          </button>
        )}
        <button
          onClick={() => dl(activeCode, 'nalu-model.scad', 'text/plain')}
          className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-xs text-[#ededed] hover:bg-white/[0.12]"
        >
          <Download size={13} /> .scad
        </button>
      </div>
      <div className="relative h-[22rem] w-full bg-[#0c0e14]">
        <div ref={mountRef} className="absolute inset-0" />
        {status !== 'done' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-sm text-[#6e7686]">
            {status === 'compiling' || status === 'repairing' ? (
              <span className="flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                {status === 'repairing' ? 'Refining the model…' : 'Compiling to 3D…'}
              </span>
            ) : (
              <span className="px-6 text-xs text-red-300">{error}</span>
            )}
          </div>
        )}
      </div>
      {showCode && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-white/[0.1] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-[#9fd0ff]">
          {activeCode}
        </pre>
      )}
    </div>
  )
}
