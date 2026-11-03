import { useEffect, useRef, type RefObject } from 'react'
import './cursor-builders.css'

type Point = { x: number; y: number }
type Kind = 'photo' | 'copy' | 'button' | 'layout' | 'guide' | 'text'
type Piece = { element: HTMLElement; kind: Kind; order: number; original: string; began?: number }
type Scene = { section: Element; pieces: Piece[]; began?: number }
const clamp = (n: number) => Math.max(0, Math.min(1, n))
const ease = (n: number) => { const p = clamp(n); return p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2 }
const mix = (a: number, b: number, p: number) => a + (b - a) * p
const colors = ['#ffffff']
const pointerShape = new Path2D('M.9.35C-.15-.16-1.2.74-.88 1.87L4.45 21.2C4.77 22.38 6.36 22.51 6.88 21.4L10.35 13.97C10.49 13.66 10.74 13.41 11.05 13.27L18.74 9.82C19.87 9.32 19.79 7.69 18.65 7.15Z')
const selectors = [
  '.nalu-scene', '.nalu-scene-grid', '.nalu-build-copy', '.nalu-hero-actions > button', '.nalu-footer-content > button', '.nalu-capability-cta',
  '.nalu-process-steps', '.nalu-core-diagram', '.nalu-process-detail',
  '.nalu-capabilities-window', '.nalu-capability-rail', '.nalu-footer-bottom', '.nalu-hero-bottom',
].join(',')

/** Scroll cues a scene. Its agents then approach, click, drag, type, and leave
 * on their own clocks, with separate paths and pauses for each actual job. */
export default function CursorBuilders({ container, reduced, active, workspace = false }: { container: RefObject<HTMLDivElement>; reduced: boolean; active: boolean; workspace?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const scenesRef = useRef<Map<Element, Scene>>(new Map())
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    const host = container.current, surface = canvas.current
    if (!host || !surface || reduced) return
    const ctx = surface.getContext('2d')
    if (!ctx) return
    const scenes = scenesRef.current
    const pieces: Piece[] = []
    let order = 0
    const registered = new WeakSet<HTMLElement>()
    const wordStyles = new Map<HTMLElement, string>()
    const workspaceSelectors = '.review-desktop-scene,.review-workspace-header,.review-header-brand,nav,.generative-home-input,.generative-home-footnote,.generative-block,.generative-library-card,.generative-fields,.generative-chart-bar,.generative-table-scroll,.generative-calculation,header,footer,h1,h2,h3,h4,p,small,label,button,input,textarea,select,output,th,td,img,svg,iframe,canvas,.nalu-build-copy'
    const register = () => {
      if (workspace) {
        for (let i = pieces.length - 1; i >= 0; i--) if (!pieces[i].element.isConnected) pieces.splice(i, 1)
        for (const [section, scene] of scenes) {
          if (!section.isConnected) scenes.delete(section)
          else scene.pieces = scene.pieces.filter(piece => piece.element.isConnected)
        }
        for (const word of wordStyles.keys()) if (!word.isConnected) wordStyles.delete(word)
      }
      for (const element of Array.from(host.querySelectorAll<HTMLElement>(workspace ? workspaceSelectors : selectors)).filter(el => !el.closest('.nalu-landing-playground,.nalu-cursor-builders'))) {
        if (registered.has(element) || element.closest('[data-cursor-exempt],.gm-style,.fallback-tile-map,.generative-motion')) continue
        // Copy is managed by BuildCopy; its internal measurement spans are never jobs.
        if (element.parentElement?.closest('.nalu-build-copy')) continue
        const section = workspace ? element.closest('.generative-block,.generative-library-card,.generative-home,.generative-capabilities,.generative-library,.generative-conversation,.generative-connections-content') || host : element.closest('section,footer')
        if (!section) continue
        const kind: Kind = element.classList.contains('nalu-scene') || element.classList.contains('review-desktop-scene') ? 'photo'
          : element.classList.contains('nalu-scene-grid') ? 'guide' : element.classList.contains('nalu-build-copy') ? 'copy'
          : element.tagName === 'BUTTON' ? 'button'
          : workspace && /^(H[1-4]|P|SMALL|LABEL|OUTPUT|TH|TD)$/.test(element.tagName) && !element.querySelector('input,textarea,select,button,.nalu-build-copy') ? 'text' : 'layout'
        const piece: Piece = { element, kind, order: order++, original: element.getAttribute('style') || '' }
        registered.add(element)
        let scene = scenes.get(section)
        if (!scene) { scene = { section, pieces: [] }; scenes.set(section, scene) }
        scene.pieces.push(piece); pieces.push(piece); element.dataset.buildPiece = kind
        for (const word of element.querySelectorAll<HTMLElement>('.nalu-build-word')) if (!wordStyles.has(word)) wordStyles.set(word, word.getAttribute('style') || '')
      }
      surface.dataset.crewSize = String(pieces.reduce((sum, piece) => sum + (piece.kind === 'photo' ? 3 : 1) + (piece.kind === 'copy' ? piece.element.querySelectorAll('.nalu-build-word').length : 0), 0))
    }
    register()
    let frame = 0, width = 0, height = 0, alive = true
    const point = (from: Point, to: Point, amount: number, id: number): Point => {
      const p = ease(amount), dx = to.x - from.x, dy = to.y - from.y
      const bend = ((id * 17 % 13) - 6) * .025
      const a = { x: from.x + dx * .25 - dy * bend, y: from.y + dy * .2 + dx * bend }
      const b = { x: to.x - dx * .2 + dy * bend, y: to.y - dy * .28 - dx * bend }
      const q = 1 - p, tremor = Math.sin(p * 19 + id) * Math.sin(Math.PI * p) * 1.8
      return { x: q ** 3 * from.x + 3 * q ** 2 * p * a.x + 3 * q * p ** 2 * b.x + p ** 3 * to.x + tremor, y: q ** 3 * from.y + 3 * q ** 2 * p * a.y + 3 * q * p ** 2 * b.y + p ** 3 * to.y - tremor * .5 }
    }
    const entrance = (id: number, target: Point) => ({ x: id % 3 === 0 ? -30 : id % 3 === 1 ? width + 30 : target.x + 120, y: id % 3 === 2 ? height + 30 : Math.max(workspace ? 12 : 110, target.y - 90 + id % 170) })
    const cursor = (id: number, position: Point, alpha: number, label: string, showLabel = true, clicking = -1) => {
      if (!activeRef.current || alpha <= 0 || position.y < (workspace ? 8 : 90) || position.y > height + 25) return
      const { x, y } = position
      ctx.save(); ctx.globalAlpha = clamp(alpha)
      if (clicking >= 0 && clicking < .35) { ctx.beginPath(); ctx.arc(x, y, 3 + clicking * 27, 0, Math.PI * 2); ctx.strokeStyle = colors[id % colors.length]; ctx.lineWidth = 1.5; ctx.globalAlpha *= 1 - clicking / .35; ctx.stroke(); ctx.globalAlpha = clamp(alpha) }
      ctx.translate(x, y)
      ctx.shadowColor = '#00000040'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1
      ctx.fillStyle = '#090b0d'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.fill(pointerShape); ctx.stroke(pointerShape)
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0
      if (showLabel) {
        ctx.font = '9px monospace'
        const text = `Nalu · ${label}`, length = ctx.measureText(text).width + 12
        const left = x + length > width - 12 ? -length : 14
        ctx.fillStyle = '#111111'; ctx.fillRect(left, 19, length, 19); ctx.fillStyle = '#ffffff'; ctx.fillText(text, left + 6, 32)
      }
      ctx.restore()
    }
    const selection = (x: number, y: number, w: number, h: number, alpha: number, id: number) => {
      ctx.save(); ctx.globalAlpha = clamp(workspace ? Math.max(.8, alpha) : alpha); ctx.strokeStyle = workspace ? '#f9f7ef' : colors[id % colors.length]; ctx.lineWidth = workspace ? 3 : 1
      ctx.strokeRect(x, y, w, h)
      if (workspace) { ctx.strokeStyle = '#283024'; ctx.lineWidth = 1.4; ctx.strokeRect(x, y, w, h); ctx.strokeStyle = '#f9f7ef' }
      for (const [dx, dy] of [[0, 0], [w / 2, 0], [w, 0], [w, h / 2], [w, h], [w / 2, h], [0, h], [0, h / 2]]) { ctx.fillStyle = '#24443d'; ctx.fillRect(x + dx - 3, y + dy - 3, 6, 6); ctx.strokeRect(x + dx - 3, y + dy - 3, 6, 6) }
      ctx.restore()
    }
    const paint = (now = performance.now()) => {
      frame = 0; ctx.clearRect(0, 0, width, height)
      const surfaceBox = surface.getBoundingClientRect()
      const hostTop = surfaceBox.top, hostLeft = surfaceBox.left
      const localBox = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.left - hostLeft, y: r.top - hostTop, w: r.width, h: r.height } }
      let running = false, jobs = 0
      for (const scene of scenes.values()) {
        if (!scene.section.isConnected) { scenes.delete(scene.section); continue }
        const rect = scene.section.getBoundingClientRect(), hero = scene.section.classList.contains('nalu-hero')
        const visible = rect.top - hostTop < height * .92 && rect.bottom - hostTop > 90
        if (scene.began === undefined && activeRef.current && (workspace || host.scrollTop > 20) && visible) scene.began = now
        const t = scene.began === undefined ? -10 : (now - scene.began) / 1000
        let copyIndex = 0, buttonIndex = 0
        for (const piece of scene.pieces) {
          const { element, kind, order: id } = piece
          if (!element.isConnected) continue
          const ownBounds = element.getBoundingClientRect()
          if (workspace && piece.began === undefined && activeRef.current && ownBounds.bottom > 0 && ownBounds.top < height && ownBounds.right > 0 && ownBounds.left < width) piece.began = now
          const card = element.closest('.nalu-capability-card')
          const cardBox = card?.getBoundingClientRect()
          if (cardBox && visible && t >= 0 && cardBox.left < width * .92 && cardBox.right > width * .08 && piece.began === undefined) piece.began = now
          const pieceTime = workspace ? piece.began === undefined ? -10 : (now - piece.began) / 1000 : card ? piece.began === undefined ? -10 : (now - piece.began) / 1000 : t
          const bounds = kind === 'photo' || kind === 'guide' ? element.parentElement!.getBoundingClientRect() : element.getBoundingClientRect()
          const x = bounds.left - hostLeft, y = bounds.top - hostTop, w = element.offsetWidth || bounds.width, h = element.offsetHeight || bounds.height
          const agentId = id * 100
          if (kind === 'photo') {
            const size = ease((t - 3.05) / 1.9)
            const source = { x: 28, y: height * .59 }, destination = { x: width * .2, y: height * .26 }
            const placed = point(source, destination, clamp((t - 1.05) / 1.35), agentId)
            const left = mix(placed.x, 0, size), upper = mix(placed.y, 0, size), scale = mix(.29, 1, size)
            element.style.transformOrigin = 'top left'; element.style.scale = String(scale); element.style.translate = `${left}px ${upper}px`
            element.style.opacity = t < .8 ? '0' : '1'
            const rendered = localBox(element)
            if (t >= 0 && t < 5.8 && visible) {
              running = true; jobs += 3
              if (t > .8) selection(rendered.x, rendered.y, rendered.w, rendered.h, clamp((5.5 - t) * 2), agentId)
              const grip = { x: source.x + 28, y: y + source.y + 18 }
              const dragging = t >= 1.05
              const operator = dragging ? { x: rendered.x + 28 * scale, y: rendered.y + 18 * scale } : point(entrance(agentId, grip), grip, clamp(t / .72), agentId)
              if (t < 2.9) cursor(agentId, operator, t < 2.5 ? 1 : clamp((2.9 - t) / .4), dragging ? 'placing background' : 'import background', true, t - .82)
              const handle = { x: x + destination.x + w * .29, y: y + destination.y + h * .29 }
              const sizing = { x: rendered.x + rendered.w, y: rendered.y + rendered.h }
              if (t > 2.2) cursor(agentId + 1, t < 3.05 ? point(entrance(agentId + 1, handle), handle, (t - 2.2) / .65, agentId + 1) : sizing, clamp((t - 2.2) * 5) * clamp((5.6 - t) * 3), t < 3.05 ? 'grab resize handle' : 'resize background', true, t - 2.94)
              const anchor = { x: x + destination.x, y: y + destination.y }
              if (t > 2.45) cursor(agentId + 2, t < 3.05 ? point(entrance(agentId + 2, anchor), anchor, (t - 2.45) / .5, agentId + 2) : { x: rendered.x, y: rendered.y }, clamp((t - 2.45) * 5) * clamp((5.6 - t) * 3), 'align background', false, t - 2.99)
            }
          } else if (kind === 'copy') {
            const index = copyIndex++, inButton = !!element.closest('button')
            const rank = card ? Array.from(card.querySelectorAll('.nalu-build-copy')).indexOf(element) : index
            const start = workspace ? .08 + rank % 8 * .035 : card ? .7 + rank * .3 : inButton ? 5.3 + index * .08 : 1.5 + index * .38
            const words = Array.from(element.querySelectorAll<HTMLElement>('.nalu-build-word'))
            const elapsed = pieceTime - start, seed = agentId % 19
            const wordEnds: number[] = []
            let clock = .72, activeWord = 0, finished = false
            const counts = words.map((word, wordIndex) => {
              const length = Number(word.dataset.letters) || 1
              let typed = 0
              for (let char = 0; char < length; char++) {
                clock += .026 + ((char * 13 + seed + wordIndex) % 7) * .008 + (char === 0 && wordIndex % 4 === 3 ? .16 : 0)
                if (elapsed >= clock) typed++
              }
              if (typed === length && wordIndex < words.length - 1) activeWord = wordIndex + 1
              wordEnds.push(clock); clock += .055
              return typed
            })
            finished = elapsed >= clock
            element.dispatchEvent(new CustomEvent('nalu-build-step', { detail: counts }))
            words.forEach((word, wordIndex) => {
              const aligned = ease((elapsed - wordEnds[wordIndex] - .3) / .6)
              word.style.transformOrigin = 'left bottom'; word.style.scale = String(mix(.9, 1, aligned)); word.style.translate = `0 ${mix(5, 0, aligned)}px`
              word.dataset.alignment = aligned === 1 ? 'placed' : 'placing'
            })
            if (elapsed >= 0 && elapsed < clock + .6 && visible && words.length) {
              running = true; jobs++
              const word = words[activeWord], r = word.getBoundingClientRect(), first = words[0].getBoundingClientRect()
              const target = { x: (word.querySelector<HTMLElement>('.nalu-build-written')?.getBoundingClientRect().right ?? r.left) - hostLeft + 2, y: r.top - hostTop + r.height * .75 }
              const initial = { x: first.left - hostLeft + 2, y: first.top - hostTop + first.height * .75 }
              let position = elapsed < .55 ? point(entrance(agentId, initial), initial, elapsed / .55, agentId) : target
              if (elapsed > clock + .2) position = point(target, { x: target.x + 28, y: target.y + 34 }, (elapsed - clock - .2) / .4, agentId)
              cursor(agentId, position, clamp(elapsed * 8) * clamp((clock + .6 - elapsed) * 5), elapsed < .72 ? 'set text' : elapsed > clock ? 'finish text' : 'typing', true, elapsed - .58)
              if (elapsed >= .72 && !finished) { ctx.save(); ctx.fillStyle = workspace ? '#283024' : '#ffffff'; ctx.fillRect(target.x, r.top - hostTop + 2, 1.3, r.height); ctx.restore() }
            }
            words.forEach((word, wordIndex) => {
              const local = elapsed - wordEnds[wordIndex] + .35
              if (local >= 0 && local < 1.65 && visible) {
                running = true; jobs++
                const r = word.getBoundingClientRect(), finish = { x: r.right - hostLeft, y: r.bottom - hostTop }
                const begin = { x: finish.x - r.width * .1, y: finish.y + 5 }
                const position = local < .55 ? point(entrance(agentId + 10 + wordIndex, begin), begin, local / .55, agentId + 10 + wordIndex) : finish
                cursor(agentId + 10 + wordIndex, position, clamp(local * 7) * clamp((1.65 - local) * 4), 'set typography', wordIndex % 8 === 0, local - .58)
                if (local > .55 && local < 1.35) selection(r.left - hostLeft, r.top - hostTop, r.width, r.height, .4, agentId + 10 + wordIndex)
              }
            })
            if (visible && pieceTime >= 0 && elapsed < clock + 1.7) running = true
            element.style.opacity = pieceTime >= start ? '1' : '0'
          } else if (kind === 'text') {
            const elapsed = pieceTime - .1, progress = ease(elapsed / 1.8)
            // Use the rendered glyph, including real wrapping and nested inline text.
            // The cursor and reveal share this caret instead of tracing an invented line.
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
            const nodes: Text[] = []; let node: Node | null
            while ((node = walker.nextNode())) nodes.push(node as Text)
            const length = nodes.reduce((sum, text) => sum + text.length, 0)
            let remaining = Math.max(1, Math.ceil(length * progress)), caret: DOMRect | undefined
            for (const text of nodes) {
              if (remaining > text.length) { remaining -= text.length; continue }
              if (text.length) { const range = document.createRange(); range.setStart(text, Math.max(0, remaining - 1)); range.setEnd(text, Math.min(text.length, remaining)); caret = range.getBoundingClientRect() }
              break
            }
            const box = localBox(element)
            const target = caret && caret.height ? { x: caret.right - hostLeft, y: caret.bottom - hostTop } : { x: box.x, y: box.y + box.h }
            if (progress >= 1) element.style.clipPath = ''
            else if (caret && box.w && box.h) {
              const sx = element.offsetWidth / box.w, sy = element.offsetHeight / box.h
              const right = Math.max(0, (target.x - box.x) * sx), top = Math.max(0, (caret.top - hostTop - box.y) * sy), bottom = Math.max(0, (target.y - box.y) * sy)
              element.style.clipPath = progress <= 0 ? 'inset(0 100% 0 0)' : `polygon(0 0,100% 0,100% ${top}px,${right}px ${top}px,${right}px ${bottom}px,0 ${bottom}px)`
            }
            if (elapsed >= 0 && elapsed < 2.35 && visible && length) {
              running = true; jobs++
              cursor(agentId, elapsed < .25 ? point(entrance(agentId, target), target, elapsed / .25, agentId) : target, clamp(elapsed * 8) * clamp((2.35 - elapsed) * 5), elapsed < .25 ? 'approach text' : 'set copy', id % 5 === 0)
              if (elapsed > .2 && elapsed < 1.95) selection(box.x, box.y, box.w, box.h, .2, agentId)
            }
          } else if (kind === 'guide') {
            element.style.opacity = String(ease((t - 4) / 1.4))
          } else {
            const index = buttonIndex++, start = workspace ? .08 + id % 10 * .03 : card ? .8 : kind === 'button' ? 2.5 + index * .48 : 1 + index * .32
            const elapsed = pieceTime - start, draw = ease((elapsed - .8) / 1.2)
            const dx = (1 - draw) * (id % 2 ? 26 : -22), dy = (1 - draw) * 18
            // A live map stays painted while agents outline its real controls.
            // Moving or fading the map provider's surface would create a blank flash.
            const liveMap = workspace && !!element.closest('[data-block-type=map]')
            if (!liveMap) {
              element.style.transformOrigin = 'top left'; element.style.translate = `${dx}px ${dy}px`
              element.style.scale = kind === 'button' ? `${mix(.12, 1, draw)} ${mix(.2, 1, draw)}` : '1'
              element.style.opacity = String(clamp((elapsed - .72) * 4))
            }
            if (!workspace) element.inert = elapsed < 2
            if (elapsed >= 0 && elapsed < 2.75 && visible) {
              running = true; jobs++
              // Read after applying this frame's transforms. Ancestor transforms,
              // reflow, scrolling and responsive scaling are already in this box.
              const box = localBox(element)
              const startPoint = { x: box.x, y: box.y }
              const end = { x: box.x + box.w, y: box.y + box.h }
              const pos = elapsed < .65 ? point(entrance(agentId, startPoint), startPoint, elapsed / .65, agentId) : elapsed < .8 ? startPoint : end
              cursor(agentId, pos, clamp(elapsed * 7) * clamp((2.75 - elapsed) * 3), kind === 'button' ? elapsed < .8 ? 'draw button' : 'size button' : 'place component', true, elapsed - .68)
              if (elapsed > .72) selection(box.x, box.y, box.w, box.h, clamp((2.7 - elapsed) * 2), agentId)
            }
          }
        }
        // Keep future scheduled jobs alive through their natural pauses.
        if (!workspace && scene.began !== undefined && t < 11 + copyIndex * .4 && visible) running = true
        if (!hero && !visible && t > 0) scene.began = Math.min(scene.began!, now - 60000)
      }
      if (workspace && activeRef.current) for (const scene of scenes.values()) for (const piece of scene.pieces) {
        if (piece.began !== undefined && now - piece.began < 3200) running = true
      }
      surface.dataset.activeJobs = String(jobs)
      if (running) frame = requestAnimationFrame(paint)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    const resize = () => {
      width = surface.clientWidth; height = surface.clientHeight
      const ratio = Math.min(window.devicePixelRatio || 1, 2); surface.width = width * ratio; surface.height = height * ratio
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); schedule()
    }
    const replay = () => { for (const scene of scenes.values()) { scene.began = undefined; scene.pieces.forEach(piece => { piece.began = undefined }) }; host.scrollTop = 0; schedule() }
    window.addEventListener('nalu-construction-replay', replay)
    host.addEventListener('scroll', schedule, { passive: true, capture: workspace })
    const mutations = workspace ? new MutationObserver(records => {
      register()
      // Revisit changed results/labels, while leaving a user's edited input alone.
      for (const record of records) {
        const parent = record.target instanceof HTMLElement ? record.target : record.target.parentElement
        if (!parent || parent.closest('.nalu-cursor-builders')) continue
        if (record.type === 'characterData' && !parent.closest('.nalu-build-copy')) {
          const piece = pieces.find(piece => piece.element === parent)
          if (piece) piece.began = performance.now()
        }
        if (record.type === 'attributes') {
          const piece = pieces.find(piece => piece.element === parent)
          if (piece) piece.began = performance.now()
        }
      }
      schedule()
    }) : null
    mutations?.observe(host, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] })
    const observer = new ResizeObserver(resize); observer.observe(host)
    void document.fonts.ready.then(() => { if (alive) schedule() })
    resize()
    return () => {
      alive = false; window.removeEventListener('nalu-construction-replay', replay); host.removeEventListener('scroll', schedule, { capture: workspace }); mutations?.disconnect(); observer.disconnect(); cancelAnimationFrame(frame)
      pieces.forEach(piece => {
        if (workspace) {
          const original = document.createElement('span').style; original.cssText = piece.original
          for (const property of ['opacity', 'scale', 'translate', 'transform-origin', 'clip-path']) {
            const value = original.getPropertyValue(property)
            if (value) piece.element.style.setProperty(property, value)
            else piece.element.style.removeProperty(property)
          }
        } else { piece.element.setAttribute('style', piece.original); piece.element.inert = false }
        delete piece.element.dataset.buildPiece
        if (piece.kind === 'copy') piece.element.dispatchEvent(new CustomEvent('nalu-build-step', { detail: 1 }))
      })
      for (const [word, style] of wordStyles) { word.setAttribute('style', style); delete word.dataset.alignment }
      scenes.clear()
    }
  }, [container, reduced, workspace])
  useEffect(() => { container.current?.dispatchEvent(new Event('scroll')) }, [active, container])
  return reduced ? null : <canvas ref={canvas} className="nalu-cursor-builders" data-workspace-cursors={workspace || undefined} aria-hidden="true" />
}
