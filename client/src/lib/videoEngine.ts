// Nalu video engine — the $0-first ladder, best available quality per device.
// ---------------------------------------------------------------------------
// One entry point every call site uses. Tries, in order:
//   1. Local MiniMax-H3 runner (real H3 + native stereo audio, on the user's
//      machine, $0) — if h3-server is running.
//   2. In-browser on-device engine (real video + synth stereo audio, works on
//      ANY device incl. phones, $0, no install).
//   3. The server /api/video ladder (free HF spaces first; paid backends only
//      if the operator configured keys).
// Callers get a URL + which engine produced it, so the UI can label it.

import { h3Available, generateWithH3 } from './localH3'
import { generateOnDeviceVideo, canRecordOnDevice, type VideoAspect } from './onDeviceVideo'
import { checkVideoAbort, durableVideoUrl, videoAttempt } from './videoLifecycle'

export type VideoEngine = 'minimax-h3' | 'on-device' | 'cloud'

export interface VideoJob {
  prompt: string
  image?: string // data URL — start frame (image→video)
  lastFrame?: string // data URL — end frame (H3 only)
  references?: string[] // data URLs — reference→video
  seconds?: number
  aspect?: VideoAspect
  audio?: boolean
  /** Fast/draft mode: trade quality for a much quicker clip (fewer steps). */
  fast?: boolean
  /** Skip the local-H3 rung (e.g. background/batch jobs that shouldn't stall). */
  skipH3?: boolean
  /** Skip the in-browser engine (e.g. caller only wants a hosted URL). */
  skipOnDevice?: boolean
  onProgress?: (fraction: number, phase: string) => void
  signal?: AbortSignal
}

export interface VideoOutput {
  url: string
  engine: VideoEngine
  onDevice: boolean
  seconds?: number
}

// Parse a clip length named in the prompt ("15 second clip", "20s", "a minute")
// so the FREE local engines (H3 / on-device) honor it too, not just the cloud
// path. Clamped to [2, 20]s. Returns undefined when nothing is stated.
function parseSecondsFromPrompt(prompt: string): number | undefined {
  const p = prompt.toLowerCase()
  if (/\bhalf\s+a?\s*min(?:ute)?\b/.test(p)) return 20
  const m = p.match(/(\d+(?:\.\d+)?)\s*(?:-|to|\s)?\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/)
  if (m) {
    let n = parseFloat(m[1])
    if (/^m|min/.test(m[2])) n *= 60
    if (Number.isFinite(n) && n > 0) return Math.min(20, Math.max(2, Math.round(n)))
  }
  return undefined
}

// A "make it quick/fast" ask → draft mode (fewer steps, skip prompt enrichment).
function inferFast(job: VideoJob): boolean {
  if (job.fast) return true
  return /\b(fast|quick(?:ly)?|asap|draft|rough|instantly?)\b/.test(job.prompt.toLowerCase())
}

// Decide 16:9 / 9:16 / 1:1 from the prompt when the caller didn't say.
function inferAspect(job: VideoJob): VideoAspect {
  if (job.aspect) return job.aspect
  const p = job.prompt.toLowerCase()
  if (/\b(reels?|tiktok|shorts?|vertical|story|stories|9:16|portrait)\b/.test(p)) return '9:16'
  if (/\b(square|1:1|instagram post)\b/.test(p)) return '1:1'
  return '16:9'
}

/**
 * Run the ladder. `onProgress` fires with a phase label ("On your device…",
 * "MiniMax-H3…", "Cloud…") so the UI can show what's happening. Throws only if
 * every rung fails.
 */
export async function generateVideo(job: VideoJob): Promise<VideoOutput> {
  checkVideoAbort(job.signal)
  const aspect = inferAspect(job)
  const progress = (fraction: number, phase: string) => { if (!job.signal?.aborted) job.onProgress?.(fraction, phase) }
  // Resolve length + speed ONCE so every rung (local H3, on-device, cloud) agrees.
  // An explicit job.seconds wins; otherwise honor a length named in the prompt.
  const seconds = job.seconds ?? parseSecondsFromPrompt(job.prompt)
  const fast = inferFast(job)
  job = { ...job, seconds, fast }

  // ---- Rung 1: local MiniMax-H3 (real H3, on device, $0) -------------------
  if (!job.skipH3) {
    try {
      if (await videoAttempt(() => h3Available(), job.signal, 2000, 'Local video availability')) {
        checkVideoAbort(job.signal)
        progress(0.02, 'MiniMax-H3 on your device…')
        const r = await videoAttempt(signal => generateWithH3({
          prompt: job.prompt,
          image: job.image,
          lastFrame: job.lastFrame,
          references: job.references,
          seconds: job.seconds,
          aspect,
          audio: job.audio,
          fast: job.fast,
          signal,
        }), job.signal, 12 * 60_000, 'Local video')
        checkVideoAbort(job.signal)
        return { url: r.url, engine: 'minimax-h3', onDevice: true, seconds: r.seconds }
      }
    } catch {
      checkVideoAbort(job.signal)
      /* H3 runner hiccup — fall through to the browser engine */
    }
  }

  // ---- Rung 2: in-browser on-device engine ($0, any device) ---------------
  // The engine has its own internal watchdogs; this outer cap is a last resort
  // so even a pathological stall can't hang the pill — it falls through to cloud.
  // The in-browser recorder tops out around 12s; a genuinely long request
  // (>12s) skips it and lands on H3 (above) or the cloud fal backend (below),
  // which natively render up to 20s.
  const wantsLong = (job.seconds || 0) > 12
  checkVideoAbort(job.signal)
  if (!job.skipOnDevice && !wantsLong && canRecordOnDevice()) {
    let recording: Awaited<ReturnType<typeof generateOnDeviceVideo>> | undefined
    try {
      const secs = Math.min(12, Math.max(3, job.seconds || 6))
      recording = await videoAttempt(
        signal => generateOnDeviceVideo({
          prompt: job.prompt,
          image: job.image,
          references: job.references,
          durationSec: secs,
          aspect,
          audio: job.audio,
          onProgress: progress,
          signal,
        }),
        job.signal,
        (secs + 120) * 1000, // seed(≤70s) + loads + film + encode, generous margin
        'On-device video',
      )
    } catch {
      checkVideoAbort(job.signal)
      /* browser engine couldn't seed/record/finish in time — fall through */
    }
    if (recording) {
      // Persist bytes, not a document-lifetime blob URL. Saving failures are
      // surfaced here; they must not start a second cloud generation.
      try {
        const url = await durableVideoUrl(recording.blob, job.signal)
        return { url, engine: 'on-device', onDevice: true, seconds: recording.durationSec }
      } finally { URL.revokeObjectURL(recording.url) }
    }
  }

  // ---- Rung 3: server ladder (free cloud pool first) ----------------------
  checkVideoAbort(job.signal)
  progress(0.5, 'Cloud video…')
  return videoAttempt(async signal => {
    const r = await fetch('/api/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: job.prompt,
        ...(job.seconds ? { seconds: job.seconds } : {}),
        ...(job.fast ? { fast: true } : {}),
        ...(job.image ? { image: job.image } : {}),
        ...(job.audio ? { audio: true } : {}),
        ...(aspect === '9:16' ? { vertical: true } : {}),
      }),
      signal,
    })
    const data = (await r.json().catch(() => ({}))) as { url?: string; error?: string; seconds?: number }
    checkVideoAbort(signal)
    if (r.ok && data.url) return { url: data.url, engine: 'cloud', onDevice: false, seconds: data.seconds }
    throw new Error(data.error || `Video error ${r.status}`)
  }, job.signal, 300_000, 'Cloud video')
}
