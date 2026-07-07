import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Brush,
  Type,
  Square,
  Trash2,
  BringToFront,
  SendToBack,
  FileImage,
  FileCode2,
  FileDown,
  Braces,
} from 'lucide-react'

// Fabric.js v6 (MIT) editable vector canvas — THE "Nalu Studio" headline artifact.
// Seeded from the AI's design JSON (canvas.loadFromJSON), fully editable in-page
// (drag / resize / edit text), with vector + raster export. Fabric is a heavy
// (~300KB) lib, so this whole module is lazy()-loaded by DesignArtifactCard and
// fabric itself is dynamically imported inside the effect — it never touches the
// main bundle. Nothing leaves the browser; all open-source.

// ---- Scene contract (matches api/design.ts {kind:'canvas'} response) ----------
// Kept local so this card compiles standalone; structurally compatible with a
// shared types.ts CanvasScene if one is later introduced.
type GradientStop = { offset: number; color: string }
type Gradient = {
  type: 'linear' | 'radial'
  coords?: Record<string, number>
  colorStops?: GradientStop[]
}
export type CanvasObject = {
  type: string
  left?: number
  top?: number
  width?: number
  height?: number
  radius?: number
  fill?: string | Gradient
  stroke?: string
  strokeWidth?: number
  opacity?: number
  angle?: number
  rx?: number
  ry?: number
  // textbox
  text?: string
  fontSize?: number
  fontWeight?: string | number
  fontFamily?: string
  fontStyle?: string
  textAlign?: string
  lineHeight?: number
  charSpacing?: number
  // image
  src?: string
  crossOrigin?: string
  // passthrough for points / paths / groups etc.
  [k: string]: unknown
}
export type CanvasScene = {
  width?: number
  height?: number
  background?: string
  objects?: CanvasObject[]
}

export type CanvasArtifact = {
  kind: 'canvas'
  name?: string
  canvas: CanvasScene
}

// Minimal structural typing for the bits of fabric v6 we touch (avoids @types/fabric,
// which targets v5 and mis-types v6). fabric ships its own types but we import it
// dynamically, so we describe the surface we use here.
interface FabricObject {
  type?: string
}
interface FabricCanvas {
  setDimensions(d: { width: number; height: number }): void
  setZoom(v: number): void
  getZoom(): number
  backgroundColor: string
  loadFromJSON(json: unknown): Promise<FabricCanvas>
  toJSON(): unknown
  toSVG(): string
  toDataURL(opts: { format: string; multiplier: number; quality?: number }): string
  getActiveObject(): FabricObject | null
  getActiveObjects(): FabricObject[]
  add(...o: FabricObject[]): void
  remove(...o: FabricObject[]): void
  bringObjectToFront(o: FabricObject): void
  sendObjectToBack(o: FabricObject): void
  discardActiveObject(): void
  requestRenderAll(): void
  setActiveObject(o: FabricObject): void
  dispose(): Promise<boolean> | void
}
interface FabricModule {
  Canvas: new (el: HTMLCanvasElement, opts?: Record<string, unknown>) => FabricCanvas
  Rect: new (opts: Record<string, unknown>) => FabricObject
  Textbox: new (text: string, opts: Record<string, unknown>) => FabricObject
}

const MAX_STAGE_W = 760 // chat column cap; scene is scaled down to fit

function safeName(n?: string): string {
  return (n || 'nalu-studio').replace(/[\\/:*?"<>|]+/g, '').trim() || 'nalu-studio'
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export default function CanvasCard({ art }: { art: CanvasArtifact }) {
  const elRef = useRef<HTMLCanvasElement | null>(null)
  const fabricRef = useRef<FabricModule | null>(null)
  const canvasRef = useRef<FabricCanvas | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const scene = art.canvas || {}
  const sceneW = Math.max(1, scene.width || 1080)
  const sceneH = Math.max(1, scene.height || 1350)
  const bg = scene.background || '#0B1020'
  // Fit the scene into the chat column. We DO NOT CSS-transform fabric's canvas
  // (that breaks fabric's pointer→scene mapping and hit-testing). Instead the
  // backstore + CSS are sized to the fitted display size and fabric's own zoom
  // scales the high-res scene down — so clicks/drags stay pixel-accurate.
  const fitScale = Math.min(1, MAX_STAGE_W / sceneW)
  const stageW = Math.max(1, Math.round(sceneW * fitScale))
  const stageH = Math.max(1, Math.round(sceneH * fitScale))
  const name = safeName(art.name)

  useEffect(() => {
    let disposed = false
    const el = elRef.current
    if (!el) return

    ;(async () => {
      try {
        // Dynamic import — fabric stays out of the main bundle. v6: `import * as fabric`.
        const mod = (await import('fabric')) as unknown as FabricModule
        // Guard StrictMode double-mount: bail before constructing if cleanup ran.
        if (disposed) return
        fabricRef.current = mod

        const c = new mod.Canvas(el, {
          preserveObjectStacking: true,
          backgroundColor: bg,
        })
        canvasRef.current = c

        // Display the scene at fitted size; zoom maps full-res scene → display.
        c.setDimensions({ width: stageW, height: stageH })
        c.setZoom(fitScale)

        const objects = Array.isArray(scene.objects) ? scene.objects : []
        // Hydrate the AI-authored scene. Fabric v6 loadFromJSON is async/Promise-based
        // and does NOT alter canvas dimensions, so the zoom/size set above survive it.
        await c.loadFromJSON({ background: bg, objects })
        if (disposed) {
          void c.dispose()
          return
        }
        c.backgroundColor = bg
        c.setZoom(fitScale) // re-assert in case the JSON carried a viewport transform
        c.requestRenderAll()
        setReady(true)
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : 'Failed to load canvas editor.')
      }
    })()

    return () => {
      disposed = true
      setReady(false)
      const c = canvasRef.current
      canvasRef.current = null
      if (c) {
        try {
          void c.dispose()
        } catch {
          /* noop */
        }
      }
    }
    // Re-seed only when the underlying artifact changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [art])

  // ---- Editing actions -------------------------------------------------------
  const addText = useCallback(() => {
    const fab = fabricRef.current
    const c = canvasRef.current
    if (!fab || !c) return
    const t = new fab.Textbox('Double-click to edit', {
      left: sceneW / 2 - 140,
      top: sceneH / 2 - 20,
      width: 280,
      fontSize: 40,
      fill: '#ffffff',
      fontFamily: 'Inter, system-ui, sans-serif',
      textAlign: 'center',
    })
    c.add(t)
    c.setActiveObject(t)
    c.requestRenderAll()
  }, [sceneW, sceneH])

  const addRect = useCallback(() => {
    const fab = fabricRef.current
    const c = canvasRef.current
    if (!fab || !c) return
    const r = new fab.Rect({
      left: sceneW / 2 - 100,
      top: sceneH / 2 - 60,
      width: 200,
      height: 120,
      rx: 12,
      ry: 12,
      fill: '#6D5BFF',
    })
    c.add(r)
    c.setActiveObject(r)
    c.requestRenderAll()
  }, [sceneW, sceneH])

  const deleteActive = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const active = c.getActiveObjects()
    if (!active.length) return
    c.remove(...active)
    c.discardActiveObject()
    c.requestRenderAll()
  }, [])

  const bringForward = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const o = c.getActiveObject()
    if (o) {
      c.bringObjectToFront(o)
      c.requestRenderAll()
    }
  }, [])

  const sendBack = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const o = c.getActiveObject()
    if (o) {
      c.sendObjectToBack(o)
      c.requestRenderAll()
    }
  }, [])

  // ---- Exports ---------------------------------------------------------------
  // Display zoom is fitScale; multiplier 1/fitScale recovers the TRUE scene
  // resolution (stageW/fitScale === sceneW) regardless of how small the preview is.
  const exportMultiplier = 1 / fitScale

  const exportPng = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    try {
      const url = c.toDataURL({ format: 'png', multiplier: exportMultiplier })
      triggerDownload(url, `${name}.png`)
    } catch {
      setError('PNG export failed (a remote image may have tainted the canvas).')
    }
  }, [name, exportMultiplier])

  const exportSvg = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    // toSVG() emits scene-space vector geometry (zoom-independent) — full fidelity.
    const svg = c.toSVG()
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    triggerDownload(url, `${name}.svg`)
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }, [name])

  const exportJson = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const json = JSON.stringify({ kind: 'canvas', name: art.name, canvas: c.toJSON() }, null, 2)
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    triggerDownload(url, `${name}.json`)
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }, [name, art.name])

  const exportPdf = useCallback(async () => {
    const c = canvasRef.current
    if (!c) return
    setBusy(true)
    try {
      const png = c.toDataURL({ format: 'png', multiplier: exportMultiplier })
      const { jsPDF } = await import('jspdf')
      const orientation = sceneW >= sceneH ? 'landscape' : 'portrait'
      const pdf = new jsPDF({ orientation, unit: 'px', format: [sceneW, sceneH] })
      pdf.addImage(png, 'PNG', 0, 0, sceneW, sceneH)
      pdf.save(`${name}.pdf`)
    } catch {
      setError('PDF export failed.')
    } finally {
      setBusy(false)
    }
  }, [name, sceneW, sceneH, exportMultiplier])

  const toolBtn =
    'flex items-center gap-1.5 rounded-lg bg-glass/[0.07] px-2.5 py-1.5 text-xs text-ink hover:bg-glass/[0.12] disabled:opacity-40'
  const exportBtn =
    'flex items-center gap-1.5 rounded-lg bg-fuchsia-500/20 px-2.5 py-1.5 text-xs font-medium text-fuchsia-200 hover:bg-fuchsia-500/30 disabled:opacity-40'

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-glass/[0.16] bg-glass/[0.04]">
      <div className="flex flex-wrap items-center gap-2 border-b border-glass/[0.12] px-4 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-fuchsia-500/15 text-fuchsia-300">
          <Brush size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">Nalu Studio</div>
          <div className="text-xs text-dim">
            Editable canvas — {sceneW}×{sceneH}
          </div>
        </div>
        <button onClick={exportPng} disabled={!ready || busy} className={exportBtn} title="Export PNG (full-res)">
          <FileImage size={13} /> PNG
        </button>
        <button onClick={exportSvg} disabled={!ready || busy} className={exportBtn} title="Export SVG (vector)">
          <FileCode2 size={13} /> SVG
        </button>
        <button onClick={exportPdf} disabled={!ready || busy} className={exportBtn} title="Export PDF">
          <FileDown size={13} /> PDF
        </button>
        <button onClick={exportJson} disabled={!ready || busy} className={toolBtn} title="Export editable JSON">
          <Braces size={13} /> JSON
        </button>
      </div>

      {/* Edit toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-glass/[0.08] bg-black/20 px-4 py-2">
        <button onClick={addText} disabled={!ready} className={toolBtn} title="Add text">
          <Type size={13} /> Text
        </button>
        <button onClick={addRect} disabled={!ready} className={toolBtn} title="Add rectangle">
          <Square size={13} /> Shape
        </button>
        <button onClick={bringForward} disabled={!ready} className={toolBtn} title="Bring to front">
          <BringToFront size={13} /> Front
        </button>
        <button onClick={sendBack} disabled={!ready} className={toolBtn} title="Send to back">
          <SendToBack size={13} /> Back
        </button>
        <button onClick={deleteActive} disabled={!ready} className={toolBtn} title="Delete selected">
          <Trash2 size={13} /> Delete
        </button>
        <span className="ml-auto hidden text-[11px] text-dim sm:block">
          Click to select · drag to move · double-click text to edit
        </span>
      </div>

      {/* Stage */}
      <div className="relative max-h-[34rem] overflow-auto bg-canvas p-4">
        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-6 text-center text-xs text-red-300">
            {error}
          </div>
        )}
        {!ready && !error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-dim">
            Loading canvas editor…
          </div>
        )}
        {/* Fabric is sized at the fitted display resolution (no CSS transform), so
            its own wrapper fits this box and pointer mapping stays accurate. */}
        <div
          className="mx-auto overflow-hidden rounded-lg shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
          style={{ width: stageW, height: stageH }}
        >
          <canvas ref={elRef} width={stageW} height={stageH} />
        </div>
      </div>
    </div>
  )
}