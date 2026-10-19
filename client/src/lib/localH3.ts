// Nalu H3 — client bridge to the local MiniMax-H3 runner (h3-server/).
// ---------------------------------------------------------------------------
// When the user runs `h3-server` on their own machine, the browser can call it
// over http://127.0.0.1 (loopback is a secure context even from an HTTPS page)
// to generate REAL MiniMax-H3 video with native stereo audio — on their device,
// $0. This module detects the runner and drives it; if it's not up, callers
// fall back to the in-browser engine (onDeviceVideo.ts), then the cloud pool.

import type { VideoAspect } from './onDeviceVideo'

const PORT = 8834
const BASE = `http://127.0.0.1:${PORT}`

// Cache the health probe briefly so we don't hammer localhost on every keystroke.
let healthCache: { at: number; ok: boolean } | null = null
const HEALTH_TTL = 15_000

/** Is the local MiniMax-H3 runner up? Fast, cached, never throws. */
export async function h3Available(): Promise<boolean> {
  const now = Date.now()
  if (healthCache && now - healthCache.at < HEALTH_TTL) return healthCache.ok
  let ok = false
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1200)
    const r = await fetch(`${BASE}/health`, { signal: ctrl.signal }).finally(() => clearTimeout(t))
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; model?: string }
      ok = !!j.ok && /h3/i.test(j.model || '')
    }
  } catch {
    ok = false // runner not installed / not running — expected
  }
  healthCache = { at: now, ok }
  return ok
}

export interface H3Request {
  prompt: string
  image?: string // data URL — image→video start frame
  lastFrame?: string // data URL — image→video end frame
  references?: string[] // data URLs — reference→video (up to 9)
  seconds?: number
  aspect?: VideoAspect
  audio?: boolean
  fast?: boolean // fewer diffusion steps → quick draft
  signal?: AbortSignal
}

function aspectDims(aspect?: VideoAspect): { height: number; width: number } {
  // 480p-class, sized to fit the 8GB NF4 path and kept on H3's grid.
  if (aspect === '9:16') return { height: 832, width: 480 }
  if (aspect === '1:1') return { height: 640, width: 640 }
  return { height: 480, width: 832 }
}

export interface H3Result {
  url: string // data:video/mp4;base64,… (video + native stereo audio)
  seconds: number
  seed: number
  onDevice: true
  engine: 'minimax-h3'
}

/**
 * Generate a clip on the local MiniMax-H3 runner. Long timeout — an 8GB machine
 * can take several minutes. Throws on any failure so the caller can fall back.
 */
export async function generateWithH3(req: H3Request): Promise<H3Result> {
  const { height, width } = aspectDims(req.aspect)
  const mode = req.references?.length ? 'ref2v' : req.image || req.lastFrame ? 'i2v' : 't2v'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12 * 60_000) // up to 12 min at 8GB
  if (req.signal) req.signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  try {
    const r = await fetch(`${BASE}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: req.prompt,
        mode,
        image: req.image,
        last_frame: req.lastFrame,
        references: req.references,
        seconds: req.seconds ?? 6,
        height,
        width,
        audio: req.audio !== false,
        ...(req.fast ? { fast: true } : {}),
      }),
      signal: ctrl.signal,
    })
    const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string; detail?: string; seconds?: number; seed?: number }
    if (!r.ok || !j.url) throw new Error(j.error || j.detail || `h3 ${r.status}`)
    return { url: j.url, seconds: j.seconds ?? req.seconds ?? 6, seed: j.seed ?? 0, onDevice: true, engine: 'minimax-h3' }
  } finally {
    clearTimeout(t)
  }
}
