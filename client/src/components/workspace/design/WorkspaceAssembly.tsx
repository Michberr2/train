import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

const pointer = 'M.9.35C-.15-.16-1.2.74-.88 1.87L4.45 21.2C4.77 22.38 6.36 22.51 6.88 21.4L10.35 13.97C10.49 13.66 10.74 13.41 11.05 13.27L18.74 9.82C19.87 9.32 19.79 7.69 18.65 7.15Z'
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const ease = (value: number) => 1 - (1 - clamp(value)) ** 3
type Job = { element: HTMLElement; box: DOMRect; started: number; duration: number; text?: Text; original: string; last: string; styles: string[]; done: boolean; id: number }
const properties = ['opacity', 'translate', 'scale', 'min-width', 'min-height']

/** Assemble actual mounted controls and copy, including artifacts that arrive
 * later. Model work and the saved workspace keep their normal lifecycle. */
export default function WorkspaceAssembly({ target, request, active, activity }: { target: RefObject<HTMLElement>; request: { key: number; label: string }; active: boolean; activity?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [narration, setNarration] = useState('')
  const work = useRef(activity); work.current = activity
  const wake = useRef<() => void>(() => {})
  useEffect(() => { wake.current() }, [activity])
  useLayoutEffect(() => {
    const root = target.current, layer = canvas.current
    if (!active || !root || !layer || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const ctx = layer.getContext('2d')
    if (!ctx) return
    const shape = new Path2D(pointer), seen = new WeakSet<HTMLElement>(), jobs: Job[] = []
    let frame = 0, alive = true, serial = 0, interacting = false, releaseTimer: ReturnType<typeof setTimeout> | undefined
    const size = () => { const ratio = Math.min(devicePixelRatio || 1, 2); layer.width = innerWidth * ratio; layer.height = innerHeight * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0) }
    size()
    const restore = (job: Job) => {
      if (job.done) return
      job.done = true
      if (job.text?.isConnected && job.text.nodeValue === job.last) job.text.nodeValue = job.original
      properties.forEach((property, index) => { if (job.styles[index]) job.element.style.setProperty(property, job.styles[index]); else job.element.style.removeProperty(property) })
    }
    const paint = (now: number) => {
      frame = 0
      if (!alive || interacting) return
      ctx.clearRect(0, 0, innerWidth, innerHeight)
      let working = false, spoken = ''
      for (const job of jobs) {
        if (job.done) continue
        if (!job.element.isConnected || job.text && job.text.nodeValue !== job.last) { restore(job); continue }
        const elapsed = (now - job.started) / 1000, progress = ease(elapsed / job.duration)
        if (elapsed > job.duration + .35) { restore(job); continue }
        working = true
        job.element.style.opacity = String(clamp(elapsed * 8))
        if (job.text) { job.last = job.original.slice(0, Math.floor(clamp(elapsed / job.duration) * job.original.length)); job.text.nodeValue = job.last }
        else { job.element.style.translate = `${(1 - progress) * (job.id % 2 ? 20 : -20)}px ${(1 - progress) * 12}px`; job.element.style.scale = String(.9 + progress * .1) }
        const box = job.element.getBoundingClientRect(), destinationX = Math.min(innerWidth - 28, box.right - 6), destinationY = Math.max(100, box.bottom - 5)
        const arriving = ease((elapsed + .25) / .4), x = (job.id % 2 ? innerWidth + 30 : -30) * (1 - arriving) + destinationX * arriving
        const y = (box.top - 90) * (1 - arriving) + destinationY * arriving + Math.sin(arriving * Math.PI) * 30
        const label = job.text ? 'typing' : job.element.tagName === 'IMG' ? 'place image' : job.element.tagName === 'BUTTON' ? 'build button' : 'arrange controls'
        if (!spoken && elapsed >= 0) spoken = job.text ? `Nalu is typing ${job.original.length > 55 ? 'the workspace text' : `“${job.original}”`}.` : `Nalu is ${job.element.tagName === 'IMG' ? 'placing an image' : job.element.tagName === 'BUTTON' ? 'building the controls' : 'arranging the workspace'}.`
        ctx.save(); ctx.globalAlpha = clamp(elapsed * 6 + .4) * clamp((job.duration + .35 - elapsed) / .3); ctx.translate(x, y)
        ctx.fillStyle = '#090b0d'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.shadowColor = '#0005'; ctx.shadowBlur = 4; ctx.fill(shape); ctx.stroke(shape)
        ctx.shadowBlur = 0; ctx.font = '9px monospace'; const text = `Nalu · ${label}`, width = ctx.measureText(text).width + 12, left = x + width + 16 > innerWidth ? -width : 14
        ctx.fillRect(left, 22, width, 18); ctx.fillStyle = '#fff'; ctx.fillText(text, left + 6, 34); ctx.restore()
      }
      if (!working && work.current) {
        const candidate = root.querySelector<HTMLElement>('[data-agent-typing],textarea,input,[role="status"],button')
        const visible = candidate && getComputedStyle(candidate).visibility !== 'hidden'
        const destination = visible ? candidate : document.querySelector<HTMLElement>('.workspace-chat-popover textarea')
        const box = destination?.getBoundingClientRect() || root.getBoundingClientRect()
        const x = Math.min(innerWidth - 30, box.right - 12), y = Math.max(95, Math.min(innerHeight - 110, box.bottom + 9))
        ctx.save(); ctx.translate(x, y); ctx.fillStyle = '#090b0d'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.fill(shape); ctx.stroke(shape)
        ctx.beginPath(); ctx.arc(9, 10, 21 + Math.sin(now / 700) * 2, 0, Math.PI * 2); ctx.strokeStyle = '#ffffff75'; ctx.stroke(); ctx.restore()
      }
      setNarration(previous => { const next = spoken || work.current || ''; return previous === next ? previous : next })
      layer.dataset.assembling = String(working)
      if (working || work.current) frame = requestAnimationFrame(paint)
    }
    const collect = () => {
      if (interacting) return
      let discovered = 0
      const targets = new Set<HTMLElement>(root.querySelectorAll<HTMLElement>('h1,h2,h3,p,button,input,textarea,select,img'))
      for (const element of document.querySelectorAll<HTMLElement>('.nalu-delegated-work h1,.nalu-delegated-work h2,.nalu-delegated-work h3,.nalu-delegated-work h4,.nalu-delegated-work p,.nalu-delegated-work button,.nalu-delegated-work img')) targets.add(element)
      for (const element of targets) {
        if (seen.has(element) || discovered >= 80 || element.closest('[aria-hidden="true"],dialog,[contenteditable]') || element.closest('[role="dialog"]') && !element.closest('.nalu-delegated-work')) continue
        const box = element.getBoundingClientRect(), style = getComputedStyle(element)
        if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.top > innerHeight || style.visibility === 'hidden' || style.display === 'none') continue
        seen.add(element)
        const text = element.childNodes.length === 1 && element.firstChild?.nodeType === Node.TEXT_NODE && element.textContent?.trim() ? element.firstChild as Text : undefined
        const original = text?.nodeValue || '', id = serial++
        const job: Job = { element, box, text, original, last: original, id, done: false, started: performance.now() + discovered * 28, duration: text ? Math.min(1.7, Math.max(.55, original.length / 75)) : .7, styles: properties.map(property => element.style.getPropertyValue(property)) }
        jobs.push(job); discovered++
        element.style.opacity = '0'
        if (text) { element.style.minHeight = `${box.height}px`; element.style.minWidth = `${box.width}px`; text.nodeValue = ''; job.last = '' }
      }
      layer.dataset.jobs = String(serial)
      if (discovered && !frame) frame = requestAnimationFrame(paint)
    }
    wake.current = () => { if (alive && !interacting && !frame) frame = requestAnimationFrame(paint) }
    const observer = new MutationObserver(collect)
    // Chat is portaled outside the main scene. Observe its actual creation
    // nodes too, without rewriting a generated iframe's opaque document.
    observer.observe(document.body, { childList: true, subtree: true })
    collect()
    const stop = () => { jobs.forEach(restore); ctx.clearRect(0, 0, innerWidth, innerHeight); layer.dataset.assembling = 'false' }
    // Keep the clicked control in place until the browser delivers its click.
    // Restoring transforms during pointerdown moves it before pointerup, which
    // can send the click to a different element or swallow it altogether.
    const beginInteraction = () => { interacting = true; clearTimeout(releaseTimer); cancelAnimationFrame(frame); frame = 0; ctx.clearRect(0, 0, innerWidth, innerHeight) }
    const finishInteraction = () => { if (!interacting) return; clearTimeout(releaseTimer); stop(); interacting = false }
    const releaseInteraction = () => { if (interacting) releaseTimer = setTimeout(finishInteraction, 0) }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const motion = () => { if (reduced.matches) { observer.disconnect(); stop() } }
    window.addEventListener('resize', stop); window.addEventListener('pointerdown', beginInteraction, true); window.addEventListener('pointerup', releaseInteraction); window.addEventListener('pointercancel', finishInteraction); window.addEventListener('click', finishInteraction); reduced.addEventListener('change', motion)
    return () => { alive = false; wake.current = () => {}; setNarration(''); observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(releaseTimer); stop(); window.removeEventListener('resize', stop); window.removeEventListener('pointerdown', beginInteraction, true); window.removeEventListener('pointerup', releaseInteraction); window.removeEventListener('pointercancel', finishInteraction); window.removeEventListener('click', finishInteraction); reduced.removeEventListener('change', motion) }
  }, [target, request.key, active])
  return <><canvas ref={canvas} className="workspace-assembly-cursors" aria-hidden="true" aria-label={`Assembling ${request.label}`} />{(narration || activity) && active && <div className="workspace-agent-narration" role="status"><span aria-hidden="true" className="workspace-agent-narration-dot"/><span>{narration || activity}</span></div>}</>
}
