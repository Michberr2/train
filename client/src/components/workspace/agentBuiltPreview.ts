/** Presentation only, inside the existing opaque artifact sandbox. It places
 * the real completed output on screen; it never claims model/tool progress and
 * is never included in downloads or the saved artifact source. Self-contained
 * so its compiled function can be embedded without a second network bundle. */
function buildVisibleOutput() {
  const boot = () => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    if (reduced.matches) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true'); canvas.dataset.naluOutputCursors = ''
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647'
    document.documentElement.append(canvas)
    const ctx = canvas.getContext('2d')
    if (!ctx) { canvas.remove(); return }
    const shape = new Path2D('M.9.35C-.15-.16-1.2.74-.88 1.87L4.45 21.2C4.77 22.38 6.36 22.51 6.88 21.4L10.35 13.97C10.49 13.66 10.74 13.41 11.05 13.27L18.74 9.82C19.87 9.32 19.79 7.69 18.65 7.15Z')
    type Work = { element: HTMLElement; text?: Text; original: string; last: string; opacity: string; minHeight: string; scale: string; appliedScale: string; appliedOpacity: string; appliedHeight: string; start: number; duration: number; id: number }
    const active = new Set<Work>(), seen = new WeakSet<Element>()
    let frame = 0, sequence = 0, stopped = false, wasBuilding = false
    const clamp = (value: number) => Math.max(0, Math.min(1, value))
    const size = () => { const ratio = Math.min(devicePixelRatio || 1, 2); canvas.width = innerWidth * ratio; canvas.height = innerHeight * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0) }
    size()
    const announce = () => {
      const building = active.size > 0
      canvas.dataset.jobs = String(sequence)
      document.documentElement.dataset.naluOutputBuilding = String(building)
      if (building === wasBuilding) return
      wasBuilding = building
      parent.postMessage({ type: 'nalu-output-build', active: building }, '*')
      if (!building) dispatchEvent(new Event('nalu-output-assembled'))
    }
    const restore = (job: Work) => {
      if (job.text?.isConnected && job.text.nodeValue === job.last) job.text.nodeValue = job.original
      if (job.element.style.opacity === job.appliedOpacity) job.element.style.opacity = job.opacity
      if (job.element.style.minHeight === job.appliedHeight) job.element.style.minHeight = job.minHeight
      if (job.element.style.scale === job.appliedScale) job.element.style.scale = job.scale
      active.delete(job)
    }
    const paint = (now: number) => {
      frame = 0; ctx.clearRect(0, 0, innerWidth, innerHeight)
      for (const job of active) {
        const elapsed = now - job.start, progress = clamp(elapsed / job.duration)
        if (!job.element.isConnected || job.text && job.text.nodeValue !== job.last || elapsed > job.duration + 200) { restore(job); continue }
        if (elapsed < 0) continue
        job.appliedOpacity = String(clamp(elapsed / 120)); job.element.style.opacity = job.appliedOpacity
        if (!job.text) { job.appliedScale = String(.9 + .1 * (1 - (1 - progress) ** 3)); job.element.style.scale = job.appliedScale }
        if (job.text) { job.last = job.original.slice(0, Math.floor(progress * job.original.length)); job.text.nodeValue = job.last }
        const box = job.element.getBoundingClientRect()
        if (box.bottom < 0 || box.top > innerHeight) continue
        const arrival = 1 - (1 - clamp(elapsed / 480)) ** 3
        const targetX = Math.max(20, Math.min(innerWidth - 35, box.left + Math.min(box.width - 10, 18 + progress * Math.max(10, box.width - 35))))
        const x = (job.id % 2 ? innerWidth + 20 : -20) * (1 - arrival) + targetX * arrival
        const y = Math.max(20, Math.min(innerHeight - 35, box.top + Math.min(box.height, 24))) - (1 - arrival) * 80 + Math.sin(arrival * Math.PI) * 22
        ctx.save(); ctx.translate(x, y); ctx.globalAlpha = Math.min(1, (job.duration + 200 - elapsed) / 180)
        ctx.fillStyle = '#090b0d'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.shadowColor = '#0005'; ctx.shadowBlur = 4; ctx.fill(shape); ctx.stroke(shape)
        ctx.shadowBlur = 0; ctx.font = '10px system-ui'; const label = job.text ? 'Nalu · typing' : job.element.tagName === 'IMG' ? 'Nalu · placing image' : 'Nalu · placing control', width = ctx.measureText(label).width + 12
        const left = x + width + 16 > innerWidth ? -width : 14
        ctx.fillRect(left, 23, width, 19); ctx.fillStyle = '#fff'; ctx.fillText(label, left + 6, 36); ctx.restore()
      }
      announce()
      if (active.size && !stopped) frame = requestAnimationFrame(paint)
    }
    const begin = (element: HTMLElement) => {
      if (stopped || element.closest('input,textarea,[contenteditable],pre,code,[hidden],[aria-hidden="true"]')) return
      const box = element.getBoundingClientRect(), style = getComputedStyle(element)
      if (box.width < 2 || box.height < 2 || style.visibility === 'hidden' || style.display === 'none') return
      const text = element.childNodes.length === 1 && element.firstChild?.nodeType === Node.TEXT_NODE && element.textContent?.trim() ? element.firstChild as Text : undefined
      const original = text?.nodeValue || '', height = text ? `${box.height}px` : element.style.minHeight
      const job: Work = { element, text, original, last: '', opacity: element.style.opacity, minHeight: element.style.minHeight, scale: element.style.scale, appliedScale: element.style.scale, appliedOpacity: '0', appliedHeight: height, start: performance.now() + Math.min(350, active.size * 22), duration: text ? Math.min(1800, Math.max(650, original.length * 15)) : 800, id: sequence++ }
      element.style.opacity = '0'; element.style.minHeight = height
      if (text) text.nodeValue = ''
      active.add(job); announce(); if (!frame) frame = requestAnimationFrame(paint)
    }
    const intersection = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { intersection.unobserve(entry.target); begin(entry.target as HTMLElement) } }, { threshold: .08 })
    const collect = () => { for (const element of document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,button,a,img,label')) if (!seen.has(element)) { seen.add(element); intersection.observe(element) } }
    const mutation = new MutationObserver(collect)
    mutation.observe(document.body, { childList: true, subtree: true }); collect()
    const finish = () => {
      if (stopped) return
      stopped = true; intersection.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame)
      for (const job of active) restore(job)
      announce(); canvas.remove()
      removeEventListener('resize', resized); removeEventListener('pointerdown', interact, true); removeEventListener('keydown', finish, true); reduced.removeEventListener('change', finish)
    }
    const resized = () => { for (const job of active) restore(job); size(); announce() }
    // A touch on empty page space may begin scrolling. Keep scroll-driven
    // construction alive; yield immediately when a real control is used.
    const interact = (event: Event) => { if (event.target instanceof Element && event.target.closest('a,button,input,textarea,select,[contenteditable],[role="button"]')) finish() }
    addEventListener('resize', resized); addEventListener('pointerdown', interact, true); addEventListener('keydown', finish, true); reduced.addEventListener('change', finish)
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot, { once: true }); else boot()
}

export function agentBuiltPreview(html: string): string {
  const script = `<script>(${buildVisibleOutput.toString()})()</script>`
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, script + '$&') : html + script
}
