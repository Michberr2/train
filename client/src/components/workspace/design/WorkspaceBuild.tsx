import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import NaluMark from '../../landing/NaluMark'
import './workspace-build.css'

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const ease = (value: number) => { const t = clamp(value); return 1 - (1 - t) ** 3 }
const pointerPath = 'M.9.35C-.15-.16-1.2.74-.88 1.87L4.45 21.2C4.77 22.38 6.36 22.51 6.88 21.4L10.35 13.97C10.49 13.66 10.74 13.41 11.05 13.27L18.74 9.82C19.87 9.32 19.79 7.69 18.65 7.15Z'
const targets = '.review-desktop-scene,.review-header-brand,.workspace-account-menu,.workspace-app-dock,.workspace-app-dock button,.workspace-carousel-card[data-visible="true"],.workspace-carousel-heading,.workspace-carousel-controls,.workspace-agent-tray,.nalu-build-copy'
type Piece = { element: HTMLElement; original: string | null; box: DOMRect; start: number; duration: number; opacity: number; kind: 'photo' | 'copy' | 'place'; id: number }

export function WorkspaceBuildLoading() {
  return <div className="workspace-build-loading" role="status" aria-label="Opening Nalu"><NaluMark /><span>nalu</span></div>
}

/** Constructs the real authenticated DOM. Once finished, no animation styles,
 * input restrictions, background overlays, or rendering loop remain. */
export default function WorkspaceBuild({ children }: { children: ReactNode }) {
  const [building, setBuilding] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const host = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const finishRef = useRef<() => void>(() => setBuilding(false))
  useLayoutEffect(() => {
    const root = host.current, body = content.current, layer = canvas.current
    if (!building || !root || !body || !layer) return
    const ctx = layer.getContext('2d')
    if (!ctx) { setBuilding(false); return }
    const shape = new Path2D(pointerPath), pieces: Piece[] = [], known = new Set<HTMLElement>()
    const began = performance.now()
    let frame = 0, alive = true, complete = false, width = innerWidth, height = innerHeight
    const ratio = Math.min(devicePixelRatio || 1, 2)
    layer.width = width * ratio; layer.height = height * ratio; ctx.scale(ratio, ratio)
    const discover = () => {
      for (const element of body.querySelectorAll<HTMLElement>(targets)) {
        if (known.has(element)) continue
        const card = element.closest('.workspace-carousel-card')
        if (card && card.getAttribute('data-visible') !== 'true') continue
        const box = element.getBoundingClientRect()
        if (!box.width || !box.height) continue
        const kind = element.classList.contains('review-desktop-scene') ? 'photo' : element.classList.contains('nalu-build-copy') ? 'copy' : 'place'
        const id = pieces.length
        const start = Math.max((performance.now() - began) / 1000 + .1, kind === 'photo' ? .35 : kind === 'copy' ? 2.1 + id % 4 * .12 : .9 + id % 8 * .14)
        pieces.push({ element, original: element.getAttribute('style'), box, start, duration: kind === 'photo' ? 1.7 : kind === 'copy' ? Math.min(2, Math.max(.6, (element.getAttribute('aria-label')?.length || 20) / 65)) : .95, opacity: Number(getComputedStyle(element).opacity), kind, id })
        known.add(element); element.style.visibility = 'visible'; element.style.opacity = '0'
        if (kind === 'copy') element.dispatchEvent(new CustomEvent('nalu-build-step', { detail: 0 }))
      }
      layer.dataset.agentJobs = String(pieces.length)
      root.dataset.buildReady = 'true'
    }
    const restore = () => {
      for (const { element, original, kind } of pieces) {
        if (original === null) element.removeAttribute('style'); else element.setAttribute('style', original)
        if (kind === 'copy') element.dispatchEvent(new CustomEvent('nalu-build-step', { detail: 1 }))
      }
      root.style.removeProperty('background'); delete root.dataset.buildReady
      body.inert = false
    }
    const finish = () => { if (complete) return; complete = true; restore(); setBuilding(false) }
    finishRef.current = finish
    const actor = (id: number, x: number, y: number, local: number, duration: number, label: string) => {
      if (local < -.55 || local > duration + .55) return
      const arrival = ease((local + .55) / .55), exit = clamp((duration + .55 - local) / .45)
      const entryX = id % 2 ? width + 40 : -40, entryY = Math.max(10, y - 100 + id % 80)
      const bend = Math.sin(arrival * Math.PI) * (id % 2 ? 32 : -28)
      ctx.save(); ctx.globalAlpha = clamp(arrival * 4) * exit
      ctx.translate(entryX + (x - entryX) * arrival, entryY + (y - entryY) * arrival + bend)
      if (local >= 0 && local < .22) { ctx.beginPath(); ctx.arc(0, 0, 4 + local * 30, 0, Math.PI * 2); ctx.strokeStyle = '#ffffff'; ctx.globalAlpha *= 1 - local / .22; ctx.stroke(); ctx.globalAlpha = exit }
      ctx.fillStyle = '#090b0d'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.shadowColor = '#0006'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1; ctx.fill(shape); ctx.stroke(shape)
      ctx.shadowBlur = 0; ctx.font = '9px monospace'
      const text = `Nalu · ${label}`, length = ctx.measureText(text).width + 12
      const left = x + length > width - 20 ? -length : 14
      ctx.fillStyle = '#090b0d'; ctx.fillRect(left, 22, length, 19); ctx.fillStyle = '#fff'; ctx.fillText(text, left + 6, 35); ctx.restore()
    }
    const paint = (now: number) => {
      if (!alive || complete) return
      const time = (now - began) / 1000
      ctx.clearRect(0, 0, width, height)
      const frameColor = Math.round(ease((time - 1.7) / 1.1) * 255)
      root.style.background = `rgb(${frameColor},${frameColor},${frameColor})`
      for (const piece of pieces) {
        const { element, kind, id, box, duration } = piece, local = time - piece.start, p = ease(local / duration)
        element.style.opacity = String(clamp(local * 9) * piece.opacity)
        if (kind === 'photo') {
          const scale = .2 + .8 * p, x = (width * .43 - box.left) * (1 - p), y = (height * .32 - box.top) * (1 - p)
          element.style.transformOrigin = 'top left'; element.style.translate = `${x}px ${y}px`; element.style.scale = String(scale)
          const left = box.left + x, top = box.top + y, w = box.width * scale, h = box.height * scale
          if (local > -.1 && local < duration + .3) {
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(left, top, w, h)
            for (const [dx, dy] of [[0, 0], [w, 0], [0, h], [w, h]]) { ctx.fillStyle = '#090b0d'; ctx.fillRect(left + dx - 3, top + dy - 3, 6, 6); ctx.strokeRect(left + dx - 3, top + dy - 3, 6, 6) }
          }
          actor(id, left, top, local, duration, 'bring in the background')
          actor(id + 1, left + w, top + h, local - .13, duration, 'resize the scene')
        } else if (kind === 'copy') {
          const words = Array.from(element.querySelectorAll<HTMLElement>('.nalu-build-word'))
          const total = words.reduce((sum, word) => sum + Number(word.dataset.letters), 0)
          let typed = Math.floor(clamp(local / duration) * total), active = words[0]
          const counts = words.map(word => { const count = Math.max(0, Math.min(typed, Number(word.dataset.letters))); typed -= count; if (count) active = word; return count })
          element.dispatchEvent(new CustomEvent('nalu-build-step', { detail: counts }))
          const caret = active?.querySelector('.nalu-build-written')?.getBoundingClientRect()
          actor(id, caret?.right || box.left, (caret?.top || box.top) + (caret?.height || box.height) * .8, local, duration, 'typing')
        } else {
          const offset = (1 - p) * (id % 2 ? 45 : -45)
          element.style.translate = `${offset}px ${(1 - p) * 24}px`; element.style.scale = String(.86 + p * .14)
          actor(id, box.right + offset - 8, box.bottom + (1 - p) * 24 - 8, local, duration, element.tagName === 'BUTTON' ? 'place the button' : 'arrange the workspace')
        }
      }
      if (time > 6.2 && (body.querySelector('.workspace-carousel-root') || time > 10)) { finish(); return }
      frame = requestAnimationFrame(paint)
    }
    const observer = new MutationObserver(discover)
    observer.observe(body, { childList: true, subtree: true })
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); finish() } }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const motion = () => { if (reduced.matches) finish() }
    body.inert = true; discover(); frame = requestAnimationFrame(paint)
    window.addEventListener('resize', finish); window.addEventListener('keydown', key); reduced.addEventListener('change', motion)
    return () => { alive = false; cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', finish); window.removeEventListener('keydown', key); reduced.removeEventListener('change', motion); restore() }
  }, [building])
  return <div ref={host} className="workspace-build" data-build-state={building ? 'building' : 'ready'}>
    <div ref={content} className="workspace-build-content" {...(building ? { inert: '' } as Record<string, string> : {})}>{children}</div>
    {building && <><canvas ref={canvas} className="workspace-build-agents" aria-hidden="true"/><button className="workspace-build-skip" onClick={() => finishRef.current()}>Open workspace now <span aria-hidden="true">↗</span></button></>}
  </div>
}
