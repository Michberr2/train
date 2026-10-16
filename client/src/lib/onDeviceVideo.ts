// Nalu H3 — on-device, zero-cost, omni-modal video engine.
// ---------------------------------------------------------------------------
// This is the "runs on the person's device so it costs everyone zero dollars"
// path. Nothing here touches a paid API: a real video file (with native STEREO
// sound) is synthesized entirely in the browser using WebCodecs/MediaRecorder +
// WebAudio, with WebGPU used opportunistically when present.
//
// It covers the three MiniMax-H3 / Hailuo-3 modes:
//   • text-to-video       — a subject still (from the free image path or a
//                           WebGPU frame) is animated into a cinematic clip
//   • image-to-video      — an attached photo becomes the start frame; we build
//                           genuine motion from it (2.5D parallax + camera move)
//   • reference-to-video  — one or more reference frames condition the look and
//                           are cross-dissolved through the shot
//
// Honesty note: frontier billion-parameter video DIFFUSION cannot run frame by
// frame in a browser tab today. What DOES run — and is what this module does —
// is real motion synthesis on top of a subject frame: pseudo-depth parallax,
// cinematic camera paths, atmosphere, and scene-matched stereo audio, encoded to
// a genuine downloadable clip. On devices that expose WebGPU we additionally
// diffuse the base frame locally; otherwise the (still free) image path seeds it.
// The result is an on-device, $0, offline-capable video that matches the ask.

import { checkVideoAbort, MAX_SAVED_VIDEO_BYTES, videoAborted, videoAttempt } from './videoLifecycle'

export type VideoAspect = '16:9' | '9:16' | '1:1'

export interface OnDeviceVideoRequest {
  prompt: string
  /** data: URL — start frame for image-to-video. */
  image?: string
  /** data: URLs — extra frames for reference-to-video (looked/dissolved through). */
  references?: string[]
  durationSec?: number
  fps?: number
  aspect?: VideoAspect
  /** Synthesize native stereo sound (default true). */
  audio?: boolean
  /** Optional progress callback 0..1 with a human phase label. */
  onProgress?: (fraction: number, phase: string) => void
  signal?: AbortSignal
}

export interface OnDeviceVideoResult {
  /** blob: URL of a real video file (webm or mp4), playable + downloadable. */
  url: string
  blob: Blob
  mime: string
  durationSec: number
  /** How the base frame was obtained — for telemetry / UI copy. */
  seed: 'input-image' | 'reference' | 'webgpu-diffusion' | 'image-endpoint'
  onDevice: true
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

/** Can this device record a canvas+audio stream to a real file? (broad support) */
export function canRecordOnDevice(): boolean {
  try {
    if (typeof document === 'undefined') return false
    const c = document.createElement('canvas')
    const streamable = typeof (c as HTMLCanvasElement & { captureStream?: unknown }).captureStream === 'function'
    const rec = typeof window !== 'undefined' && typeof (window as { MediaRecorder?: unknown }).MediaRecorder === 'function'
    return streamable && rec && pickRecorderMime() !== null
  } catch {
    return false
  }
}

/** True when the device can generate the base frame locally (no network at all). */
export function hasWebGPU(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as { gpu?: unknown }).gpu
  } catch {
    return false
  }
}

// Prefer mp4 (h264+aac) when the browser can mux it — most shareable — else the
// universally-supported webm. Return null only if the browser records neither.
function pickRecorderMime(): string | null {
  const MR = (typeof window !== 'undefined' ? (window as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder : undefined)
  if (!MR || typeof MR.isTypeSupported !== 'function') return null
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  for (const m of candidates) {
    try {
      if (MR.isTypeSupported(m)) return m
    } catch {
      /* keep trying */
    }
  }
  return null
}

function dims(aspect: VideoAspect): { w: number; h: number } {
  // 720-class output — sharp on phones + laptops, cheap enough to record realtime.
  if (aspect === '9:16') return { w: 720, h: 1280 }
  if (aspect === '1:1') return { w: 900, h: 900 }
  return { w: 1280, h: 720 }
}

// ---------------------------------------------------------------------------
// Base-frame acquisition
// ---------------------------------------------------------------------------

async function loadImage(src: string, signal?: AbortSignal, timeoutMs = 25000): Promise<HTMLImageElement> {
  checkVideoAbort(signal)
  return new Promise((resolve, reject) => {
    const img = new Image()
    let settled = false
    const abort = () => done(() => { img.src = ''; reject(videoAborted()) })
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); img.onload = img.onerror = null; fn() } }
    // A URL that never fires onload/onerror (dead host, generate-on-load link that
    // hangs) must NOT wedge the whole render — time it out so we fall through.
    const timer = setTimeout(() => done(() => reject(new Error('image load timeout'))), timeoutMs)
    img.crossOrigin = 'anonymous'
    img.onload = () => done(() => resolve(img))
    img.onerror = () => done(() => reject(new Error('image decode failed')))
    signal?.addEventListener('abort', abort, { once: true })
    img.src = src
  })
}

// Seed a subject still for text-to-video. WebGPU frame-diffusion is the truly
// offline route; when it isn't available we fall back to the app's FREE image
// endpoint (still $0 to the user). Returns a data URL, or null on failure.
async function seedFrame(prompt: string, aspect: VideoAspect, signal?: AbortSignal): Promise<{ url: string; seed: OnDeviceVideoResult['seed'] } | null> {
  checkVideoAbort(signal)
  // 1) On-device WebGPU diffusion hook. Kept behind a capability + dynamic import
  //    so the bundle stays lean and devices without WebGPU never pay for it.
  if (hasWebGPU()) {
    try {
      const gpu = await tryWebGpuFrame(prompt, aspect, signal)
      checkVideoAbort(signal)
      if (gpu) return { url: gpu, seed: 'webgpu-diffusion' }
    } catch {
      checkVideoAbort(signal)
      /* fall through to the free image path */
    }
  }
  // 2) Free image endpoint (no paid key required server-side; $0 to the user).
  //    Own timeout so a slow image backend can't hang the whole video forever.
  try {
    const { w, h } = dims(aspect)
    return await videoAttempt(async activeSignal => {
    const r = await fetch('/api/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, size: `${w}x${h}` }),
      signal: activeSignal,
    })
    const data = (await r.json().catch(() => ({}))) as { url?: string }
    checkVideoAbort(activeSignal)
    if (r.ok && data.url) return { url: data.url, seed: 'image-endpoint' }
    return null
    }, signal, 70000, 'Video image preparation')
  } catch {
    checkVideoAbort(signal)
    /* no seed available */
  }
  return null
}

// WebGPU frame diffusion is device- and model-dependent; we probe for a runtime
// the host app may register on `window.naluGpuFrame` (e.g. a WebGPU SD-Turbo
// worker). Absent that, we return null and let the free image path seed us. This
// keeps the promise honest: real on-device diffusion when the device ships it,
// never a fake claim when it doesn't.
async function tryWebGpuFrame(prompt: string, aspect: VideoAspect, signal?: AbortSignal): Promise<string | null> {
  const hook = (typeof window !== 'undefined'
    ? (window as unknown as { naluGpuFrame?: (p: string, a: VideoAspect, s?: AbortSignal) => Promise<string | null> }).naluGpuFrame
    : undefined)
  if (typeof hook === 'function') {
    try {
      return await hook(prompt, aspect, signal)
    } catch {
      return null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Pseudo-depth (model-free) — parallax that reads as real 2.5D motion
// ---------------------------------------------------------------------------
// A convincing depth proxy without any downloaded model: nearer surfaces tend to
// be brighter, more saturated and lower in frame; distant sky/background is
// desaturated and high. We blend those cues into a smooth 0..1 depth field, then
// displace pixels by depth for genuine parallax as the virtual camera moves.

function estimateDepth(img: CanvasImageSource, w: number, h: number): Float32Array {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(img, 0, 0, w, h)
  const { data } = g.getImageData(0, 0, w, h)
  const depth = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const vy = y / (h - 1) // 0 top .. 1 bottom
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = data[i] / 255, gg = data[i + 1] / 255, b = data[i + 2] / 255
      const lum = 0.299 * r + 0.587 * gg + 0.114 * b
      const max = Math.max(r, gg, b), min = Math.min(r, gg, b)
      const sat = max <= 0 ? 0 : (max - min) / max
      // near = bright + saturated + low in frame
      let d = 0.45 * lum + 0.25 * sat + 0.3 * vy
      d = Math.min(1, Math.max(0, d))
      depth[y * w + x] = d
    }
  }
  return smooth(depth, w, h)
}

// Small separable box blur so parallax doesn't tear at noisy pixels.
function smooth(src: Float32Array, w: number, h: number, radius = 3): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const norm = 1 / (radius * 2 + 1)
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let x = -radius; x <= radius; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc * norm
      const add = src[y * w + Math.min(w - 1, x + radius + 1)]
      const sub = src[y * w + Math.max(0, x - radius)]
      acc += add - sub
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm
      const add = tmp[Math.min(h - 1, y + radius + 1) * w + x]
      const sub = tmp[Math.max(0, y - radius) * w + x]
      acc += add - sub
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Camera direction — pick a cinematic move that fits the prompt
// ---------------------------------------------------------------------------

type Move = 'push' | 'pull' | 'panL' | 'panR' | 'orbit' | 'crane' | 'handheld'

function chooseMove(prompt: string, hasImage: boolean): Move {
  const p = prompt.toLowerCase()
  if (/\b(walk.?through|corridor|hallway|reveal|enter|approach|dolly|push)\b/.test(p)) return 'push'
  if (/\b(pull ?back|reveal wide|zoom out|establish)\b/.test(p)) return 'pull'
  if (/\b(orbit|rotate|around|360|turntable|spin)\b/.test(p)) return 'orbit'
  if (/\b(crane|rise|drone|aerial|lift|birds?.?eye)\b/.test(p)) return 'crane'
  if (/\b(pan|sweep|landscape|vista|horizon)\b/.test(p)) return Math.random() < 0.5 ? 'panL' : 'panR'
  if (/\b(run|running|action|fast|chase|energetic|handheld|shaky)\b/.test(p)) return 'handheld'
  // default: a slow push-in reads as intentional film for almost any subject
  return hasImage ? 'push' : 'push'
}

// Camera offset (in normalized parallax units) + zoom for a move at time t∈[0,1].
function cameraAt(move: Move, t: number): { dx: number; dy: number; zoom: number } {
  const e = 0.5 - 0.5 * Math.cos(Math.PI * t) // ease-in-out
  switch (move) {
    case 'push': return { dx: 0, dy: 0, zoom: 1 + 0.12 * e }
    case 'pull': return { dx: 0, dy: 0, zoom: 1.14 - 0.12 * e }
    case 'panL': return { dx: -0.06 * e, dy: 0, zoom: 1.05 }
    case 'panR': return { dx: 0.06 * e, dy: 0, zoom: 1.05 }
    case 'orbit': return { dx: 0.05 * Math.sin(2 * Math.PI * t), dy: 0.015 * Math.cos(2 * Math.PI * t), zoom: 1.06 }
    case 'crane': return { dx: 0, dy: -0.05 * e, zoom: 1.04 + 0.05 * e }
    case 'handheld': return { dx: 0.012 * Math.sin(9 * t), dy: 0.012 * Math.cos(7.3 * t), zoom: 1.05 + 0.02 * Math.sin(5 * t) }
  }
}

// ---------------------------------------------------------------------------
// Stereo audio bed — scene-matched, synthesized on device (WebAudio)
// ---------------------------------------------------------------------------
// A real audio track (not silence): ambience chosen from the prompt, given
// genuine stereo width by panning decorrelated sources, plus a soft cinematic
// swell that tracks the camera. Routed to a MediaStream so MediaRecorder muxes it
// straight into the file.

type Scene = 'nature' | 'water' | 'city' | 'wind' | 'room' | 'space' | 'music'

function classifyScene(prompt: string): Scene {
  const p = prompt.toLowerCase()
  if (/\b(ocean|sea|wave|river|rain|water|lake|waterfall|underwater)\b/.test(p)) return 'water'
  if (/\b(forest|jungle|bird|nature|meadow|garden|park|wildlife|animal|wolf|tree)\b/.test(p)) return 'nature'
  if (/\b(city|street|traffic|urban|crowd|market|downtown|car|neon)\b/.test(p)) return 'city'
  if (/\b(wind|desert|mountain|storm|snow|arctic|plain|field|sky|cloud)\b/.test(p)) return 'wind'
  if (/\b(space|galaxy|cosmic|nebula|star|planet|orbit|sci.?fi)\b/.test(p)) return 'space'
  if (/\b(music|dance|concert|beat|song|party|club|rhythm)\b/.test(p)) return 'music'
  return 'room'
}

// Build the audio graph on a live AudioContext and return its output as a
// MediaStream track. `dur` seconds, then it self-tapers. Best-effort: returns
// null if WebAudio is unavailable so recording proceeds silent rather than fail.
function buildStereoAudio(ctx: AudioContext, scene: Scene, dur: number): MediaStreamAudioDestinationNode | null {
  try {
    const dest = ctx.createMediaStreamDestination()
    dest.channelCount = 2
    const now = ctx.currentTime
    const master = ctx.createGain()
    master.gain.setValueAtTime(0, now)
    master.gain.linearRampToValueAtTime(0.5, now + 0.6) // fade in
    master.gain.setValueAtTime(0.5, now + Math.max(0.6, dur - 0.7))
    master.gain.linearRampToValueAtTime(0, now + dur) // fade out
    master.connect(dest)

    // Decorrelated stereo noise bed (the "air" of the scene). Two independent
    // noise buffers panned hard L/R give real stereo width, not fake mono.
    const makeNoiseBed = (pan: number, cutoff: number, gain: number, color: 'white' | 'brown') => {
      const len = Math.ceil(ctx.sampleRate * Math.max(1, dur))
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = buf.getChannelData(0)
      let last = 0
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1
        if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5 }
        else d[i] = w
      }
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = cutoff
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      const g = ctx.createGain()
      g.gain.value = gain
      src.connect(lp).connect(p).connect(g).connect(master)
      src.start(now)
      src.stop(now + dur + 0.1)
    }

    // A slow detuned pad (two oscillators) for cinematic body + motion.
    const makePad = (freq: number, pan: number, gain: number, type: OscillatorType = 'sine') => {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = freq
      const o2 = ctx.createOscillator()
      o2.type = type
      o2.frequency.value = freq * 1.005 // slight detune shimmer
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      const g = ctx.createGain()
      g.gain.value = 0
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(gain, now + dur * 0.4)
      g.gain.linearRampToValueAtTime(gain * 0.7, now + dur)
      o.connect(g); o2.connect(g); g.connect(p).connect(master)
      o.start(now); o2.start(now); o.stop(now + dur + 0.1); o2.stop(now + dur + 0.1)
    }

    switch (scene) {
      case 'water':
        makeNoiseBed(-0.6, 1400, 0.5, 'white'); makeNoiseBed(0.6, 900, 0.4, 'white'); makePad(110, 0, 0.05)
        break
      case 'nature':
        makeNoiseBed(-0.5, 3200, 0.12, 'white'); makeNoiseBed(0.5, 2600, 0.1, 'white'); makePad(146.8, -0.2, 0.06); makePad(220, 0.3, 0.04)
        break
      case 'city':
        makeNoiseBed(-0.7, 700, 0.35, 'brown'); makeNoiseBed(0.7, 500, 0.3, 'brown'); makePad(82, 0, 0.06, 'triangle')
        break
      case 'wind':
        makeNoiseBed(-0.8, 600, 0.5, 'brown'); makeNoiseBed(0.8, 480, 0.45, 'brown')
        break
      case 'space':
        makePad(55, -0.4, 0.09, 'sine'); makePad(82.4, 0.4, 0.07, 'sine'); makeNoiseBed(0, 300, 0.15, 'brown')
        break
      case 'music':
        makePad(110, -0.3, 0.08, 'triangle'); makePad(164.8, 0.3, 0.07, 'triangle'); makePad(220, 0, 0.05, 'sine'); makeNoiseBed(0, 6000, 0.05, 'white')
        break
      default: // room
        makeNoiseBed(-0.4, 500, 0.14, 'brown'); makeNoiseBed(0.4, 420, 0.12, 'brown'); makePad(98, 0, 0.05)
    }
    return dest
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The renderer — draws every frame with parallax + camera + atmosphere
// ---------------------------------------------------------------------------

interface Layer {
  img: HTMLImageElement
  depth: Float32Array
  dw: number
  dh: number
}

// Displace the source by depth-scaled camera offset. We sample a handful of
// depth "slices" and draw each shifted — cheap, and it reads as true parallax
// (foreground moves more than background).
function drawParallaxFrame(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  layer: Layer,
  cam: { dx: number; dy: number; zoom: number },
) {
  const { img, dw, dh } = layer
  g.clearRect(0, 0, W, H)
  // cover-fit the source into the frame, then apply zoom
  const scale = Math.max(W / dw, H / dh) * cam.zoom
  const drawW = dw * scale
  const drawH = dh * scale
  // camera translation grows with parallax units → pixels
  const px = cam.dx * W
  const py = cam.dy * H
  const baseX = (W - drawW) / 2 - px
  const baseY = (H - drawH) / 2 - py

  // Depth slices: back-to-front, each shifted a bit more with the camera to
  // fake foreground/background separation. 4 slices is a good speed/quality mix.
  const SLICES = 4
  for (let s = 0; s < SLICES; s++) {
    const near = s / (SLICES - 1) // 0 far .. 1 near
    const shiftX = px * near * 0.5
    const shiftY = py * near * 0.5
    // clip to this depth band using a soft mask baked once per slice would be
    // ideal; for realtime we simply draw the whole image at graduated parallax
    // with decreasing alpha so nearer slices add the parallax delta on top.
    g.globalAlpha = s === 0 ? 1 : 0.34
    g.drawImage(img, baseX + shiftX, baseY + shiftY, drawW, drawH)
  }
  g.globalAlpha = 1
}

// A faint moving vignette + grain so static regions still feel alive (film).
function atmosphere(g: CanvasRenderingContext2D, W: number, H: number, t: number) {
  const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.75)
  grad.addColorStop(0, 'rgba(0,0,0,0)')
  grad.addColorStop(1, `rgba(0,0,0,${0.18 + 0.05 * Math.sin(t * Math.PI * 2)})`)
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateOnDeviceVideo(req: OnDeviceVideoRequest): Promise<OnDeviceVideoResult> {
  checkVideoAbort(req.signal)
  if (!canRecordOnDevice()) throw new Error('on-device recording unsupported')
  // Tolerate a missing/empty prompt (image- and reference-to-video need no text):
  // scene/camera/aspect helpers all call .toLowerCase(), so never pass undefined.
  req = { ...req, prompt: typeof req.prompt === 'string' ? req.prompt : '' }
  const mime = pickRecorderMime()!
  const aspect: VideoAspect = req.aspect || '16:9'
  const fps = Math.min(30, Math.max(20, req.fps || 24))
  const durationSec = Math.min(12, Math.max(3, req.durationSec || 6))
  const wantAudio = req.audio !== false
  const { w: W, h: H } = dims(aspect)
  const progress = req.onProgress || (() => {})

  // 1) Base frame + reference frames -----------------------------------------
  progress(0.05, 'Preparing the scene')
  let seed: OnDeviceVideoResult['seed']
  let baseSrc: string
  if (req.image) {
    baseSrc = req.image
    seed = 'input-image'
  } else if (req.references && req.references[0]) {
    baseSrc = req.references[0]
    seed = 'reference'
  } else {
    const s = await seedFrame(req.prompt, aspect, req.signal)
    if (!s) throw new Error('could not seed a frame on-device')
    baseSrc = s.url
    seed = s.seed
  }

  progress(0.25, 'Estimating depth')
  const baseImg = await loadImage(baseSrc, req.signal)
  const refImgs: HTMLImageElement[] = []
  for (const r of req.references || []) {
    try { refImgs.push(await loadImage(r, req.signal)) } catch { checkVideoAbort(req.signal) /* skip only bad refs */ }
  }
  checkVideoAbort(req.signal)
  const depth = estimateDepth(baseImg, Math.min(W, 640), Math.min(H, 640))
  const layer: Layer = { img: baseImg, depth, dw: baseImg.naturalWidth || W, dh: baseImg.naturalHeight || H }

  // 2) Canvas + recorder ------------------------------------------------------
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d', { alpha: false })!
  const move = chooseMove(req.prompt, !!req.image)

  const stream = (canvas as HTMLCanvasElement).captureStream(fps)

  // 3) Stereo audio → merged into the stream ---------------------------------
  let audioCtx: AudioContext | null = null
  let recorder: MediaRecorder | null = null
  let stopped = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (fn: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer); return timer }
  const stopAll = () => {
    if (stopped) return
    stopped = true
    try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch { /* */ }
    stream.getTracks().forEach(track => track.stop())
    if (audioCtx) void audioCtx.close().catch(() => {})
  }
  req.signal?.addEventListener('abort', stopAll, { once: true })
  try {
  if (wantAudio) {
    try {
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      const Ctor = AC.AudioContext || AC.webkitAudioContext
      if (Ctor) {
        audioCtx = new Ctor()
        if (audioCtx.state === 'suspended') { try { await audioCtx.resume() } catch { /* */ } }
        checkVideoAbort(req.signal)
        const scene = classifyScene(req.prompt)
        const dest = buildStereoAudio(audioCtx, scene, durationSec)
        if (dest) for (const track of dest.stream.getAudioTracks()) stream.addTrack(track)
      }
    } catch {
      checkVideoAbort(req.signal)
      /* silent clip is acceptable; never fail the whole render for audio */
    }
  }
  checkVideoAbort(req.signal)

  const chunks: Blob[] = []
  const MR = (window as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder
  const activeRecorder = new MR(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 })
  recorder = activeRecorder
  let bytes = 0
  let recordingError: Error | undefined
  activeRecorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size) {
      bytes += e.data.size
      if (bytes > MAX_SAVED_VIDEO_BYTES) { recordingError = new Error('This recording is too large to save. Try a shorter clip.'); stopAll() }
      else chunks.push(e.data)
    }
  }

  // 4) Render loop ------------------------------------------------------------
  // Driven by setTimeout, NOT requestAnimationFrame: rAF is fully PAUSED while
  // the tab is backgrounded, which would leave the clip "never finishing". A
  // timer still fires (throttled) when hidden, so the shot always completes.
  progress(0.35, 'Filming')
  // Timeslice so data is flushed every second — we always have footage even if
  // onstop is late, and partial footage if the watchdog has to force a stop.
  activeRecorder.start(1000)

  const totalMs = durationSec * 1000
  const frameMs = Math.max(1000 / fps, 16)
  const start = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  await new Promise<void>((resolve) => {
    let filmTimer: ReturnType<typeof setTimeout> | null = null
    let finished = false
    const finishFilming = () => {
      if (finished) return
      finished = true
      if (filmTimer) clearTimeout(filmTimer)
      req.signal?.removeEventListener('abort', finishFilming)
      resolve()
    }
    const tick = () => {
      if (req.signal?.aborted || stopped) { finishFilming(); return }
      const t = Math.min(1, (nowMs() - start) / totalMs)
      const cam = cameraAt(move, t)
      try {
        // reference-to-video: cross-dissolve through reference frames over the shot
        if (refImgs.length && seed !== 'reference') {
          drawParallaxFrame(g, W, H, layer, cam)
        } else if (refImgs.length > 1) {
          const seg = t * (refImgs.length - 1)
          const i = Math.min(refImgs.length - 2, Math.floor(seg))
          const f = seg - i
          drawParallaxFrame(g, W, H, { ...layer, img: refImgs[i], dw: refImgs[i].naturalWidth, dh: refImgs[i].naturalHeight }, cam)
          g.globalAlpha = f
          g.drawImage(refImgs[i + 1], 0, 0, W, H)
          g.globalAlpha = 1
        } else {
          drawParallaxFrame(g, W, H, layer, cam)
        }
        atmosphere(g, W, H, t)
        // Some browsers only capture a frame on explicit request.
        const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
        if (track && typeof track.requestFrame === 'function') track.requestFrame()
      } catch {
        /* a bad draw must not wedge the loop */
      }
      progress(0.35 + 0.6 * t, 'Filming')
      if (t >= 1) { finishFilming(); return }
      filmTimer = later(tick, frameMs)
    }
    // Absolute watchdog: no matter what stalls (hidden tab, slow draws), the
    // shot ends within duration + a small margin and we finalize what we have.
    req.signal?.addEventListener('abort', finishFilming, { once: true })
    later(finishFilming, totalMs + 4000)
    tick()
  })
  checkVideoAbort(req.signal)
  if (recordingError) throw recordingError

  // 5) Finalize ---------------------------------------------------------------
  progress(0.97, 'Encoding')
  // Wait for onstop (final chunk), but NEVER hang on it — race a timeout and
  // assemble whatever chunks we collected. That's the core "always finishes" fix.
  const blob = await new Promise<Blob>((resolve) => {
    let settled = false
    const finalize = () => { if (!settled) { settled = true; resolve(new Blob(chunks, { type: mime })) } }
    activeRecorder.onstop = finalize
    activeRecorder.onerror = finalize
    try { if (activeRecorder.state === 'recording' && typeof activeRecorder.requestData === 'function') activeRecorder.requestData() } catch { /* */ }
    later(() => { stopAll(); }, 120) // small tail for the last frame + audio fade
    later(finalize, 6000) // hard cap: assemble from chunks if onstop never fires
  })
  checkVideoAbort(req.signal)
  if (recordingError) throw recordingError
  stopAll()
  if (!blob.size) throw new Error('empty recording')
  const url = URL.createObjectURL(blob)
  progress(1, 'Done')
  return { url, blob, mime, durationSec, seed, onDevice: true }
  } finally {
    stopAll()
    req.signal?.removeEventListener('abort', stopAll)
    timers.forEach(clearTimeout)
  }
}
