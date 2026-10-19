import { useEffect, useRef, useState } from 'react'

// One local geometry compile at a time. No generator, repair request, account
// access or backend call; the same stored OpenSCAD is rendered once to a still.
const snapshots = new Map<string, string>()
let queue = Promise.resolve()
function queueSnapshot(code: string, signal: AbortSignal): Promise<string> {
  const cached = snapshots.get(code)
  if (cached) return Promise.resolve(cached)
  const task = queue.then(async () => {
    if (signal.aborted) throw new Error('Preview closed')
    const cached = snapshots.get(code)
    if (cached) return cached
    const stl = await new Promise<Uint8Array>((resolve, reject) => {
      const worker = new Worker(new URL('../../workspace/openscadWorker.ts', import.meta.url), { type: 'module' })
      const finish = (error?: Error, value?: Uint8Array) => {
        clearTimeout(timeout); signal.removeEventListener('abort', abort); worker.terminate()
        if (error) reject(error); else if (value) resolve(value)
      }
      const abort = () => finish(new Error('Preview closed'))
      const timeout = window.setTimeout(() => finish(new Error('The model needs more time in its full viewer.')), 25000)
      signal.addEventListener('abort', abort, { once: true })
      worker.onmessage = (event: MessageEvent<{ stl?: Uint8Array; error?: string }>) => event.data.stl ? finish(undefined, event.data.stl) : finish(new Error(event.data.error || 'Model could not render'))
      worker.onerror = () => finish(new Error('Model could not render'))
      worker.postMessage({ code })
    })
    if (signal.aborted) throw new Error('Preview closed')
    const [THREE, { STLLoader }] = await Promise.all([import('three'), import('three/examples/jsm/loaders/STLLoader.js')])
    if (signal.aborted) throw new Error('Preview closed')
    const buffer = new ArrayBuffer(stl.byteLength); new Uint8Array(buffer).set(stl)
    const geometry = new STLLoader().parse(buffer)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    const material = new THREE.MeshStandardMaterial({ color: 0xcbd7ef, metalness: .22, roughness: .5 })
    try {
      renderer.setSize(600, 360); renderer.setPixelRatio(1)
      const scene = new THREE.Scene()
      geometry.computeBoundingBox(); geometry.center(); geometry.computeVertexNormals()
      const size = new THREE.Vector3(); geometry.boundingBox?.getSize(size)
      const radius = Math.max(size.x, size.y, size.z, 1)
      const mesh = new THREE.Mesh(geometry, material); mesh.rotation.x = -Math.PI / 2; scene.add(mesh)
      const camera = new THREE.PerspectiveCamera(38, 600 / 360, radius / 1000, radius * 50)
      camera.position.set(radius * 1.5, radius * 1.1, radius * 1.65); camera.lookAt(0, 0, 0)
      scene.add(new THREE.HemisphereLight(0xf2f4ff, 0x2b3040, 2))
      const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(radius * 2, radius * 3, radius); scene.add(key)
      renderer.render(scene, camera)
      const image = renderer.domElement.toDataURL('image/png')
      snapshots.set(code, image)
      if (snapshots.size > 20) snapshots.delete(snapshots.keys().next().value!)
      return image
    } finally { geometry.dispose(); material.dispose(); renderer.dispose(); renderer.forceContextLoss() }
  })
  queue = task.then(() => undefined, () => undefined)
  return task
}

export default function ArtifactCADPreview({ code, title }: { code: string; title: string }) {
  const root = useRef<HTMLDivElement>(null)
  const [image, setImage] = useState(() => snapshots.get(code) || '')
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let started = false
    setImage(snapshots.get(code) || ''); setError('')
    const start = () => {
      if (started) return
      started = true
      void queueSnapshot(code, controller.signal).then(value => { if (!controller.signal.aborted) setImage(value) }, () => { if (!controller.signal.aborted) setError('The saved model could not render here. Open its full viewer to inspect it.') })
    }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) start() })
    if (root.current) observer.observe(root.current)
    return () => { observer.disconnect(); controller.abort() }
  }, [code])
  return <div ref={root} className="artifact-preview-cad">{image ? <img src={image} alt=""/> : <div className="artifact-preview-unavailable"><strong>{title}</strong><p>{error || 'Rendering the saved model locally…'}</p></div>}</div>
}
