import { motionPoseAt, type MotionScene, type MotionSceneSpec, type MotionPose } from './motionScene'

// This function is serialized into the standalone artifact. Keep all runtime
// dependencies inside it; the shared, pure interpolator is passed explicitly.
function motionSceneRuntime(scene: MotionScene, spec: MotionSceneSpec, poseAt: typeof motionPoseAt) {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.getElementById('nalu-stage') as unknown as SVGSVGElement
  const defs = document.createElementNS(NS, 'defs')
  svg.append(defs)
  const element = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
    const node = document.createElementNS(NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    return node
  }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  let raf = 0, origin: number | undefined
  const players: Array<{ layer: MotionScene['layers'][number]; group: SVGGElement; clip: SVGRectElement }> = []
  const fitters: Array<() => void> = []
  const families: Record<string, string> = {
    Arial: 'Arial, Helvetica, sans-serif',
    'Arial Black': '"Arial Black", Arial, sans-serif',
    Georgia: 'Georgia, "Times New Roman", serif',
    'Courier New': '"Courier New", monospace',
    Impact: 'Impact, "Arial Black", sans-serif',
    'Trebuchet MS': '"Trebuchet MS", Arial, sans-serif',
  }
  svg.append(element('rect', { width: spec.width, height: spec.height, fill: scene.background }))
  for (const [index, layer] of scene.layers.entries()) {
    const { width: w, height: h } = layer.box
    const group = element('g', { 'data-motion-layer': layer.id })
    const clipPath = element('clipPath', { id: `nalu-wipe-${index}`, clipPathUnits: 'userSpaceOnUse' })
    const clip = element('rect', { x: 0, y: 0, width: w, height: h })
    clipPath.append(clip); defs.append(clipPath)
    const content = element('g', { 'clip-path': `url(#nalu-wipe-${index})` })
    group.append(content); svg.append(group)
    const stroke = layer.stroke && layer.stroke !== 'none' ? layer.stroke : 'none'
    const strokeWidth = stroke !== 'none' ? layer.strokeWidth ?? 1 : 0
    const paint = { fill: layer.fill, stroke, 'stroke-width': strokeWidth, 'stroke-linejoin': 'round' }
    if (layer.type === 'rect') {
      content.append(element('rect', { ...paint, x: strokeWidth / 2, y: strokeWidth / 2, width: Math.max(0, w - strokeWidth), height: Math.max(0, h - strokeWidth), rx: layer.radius || 0 }))
    } else if (layer.type === 'circle') {
      const radius = layer.radius ?? Math.max(0, (Math.min(w, h) - strokeWidth) / 2)
      content.append(element('circle', { ...paint, cx: w / 2, cy: h / 2, r: radius }))
    } else if (layer.type === 'arc') {
      const radius = layer.radius ?? Math.max(0, (Math.min(w, h) - strokeWidth) / 2)
      const start = layer.startAngle ?? 0, end = layer.endAngle ?? 270
      const point = (angle: number) => { const rad = (angle - 90) * Math.PI / 180; return [w / 2 + Math.cos(rad) * radius, h / 2 + Math.sin(rad) * radius] }
      const first = point(start), delta = end - start
      let d = `M ${first[0]} ${first[1]}`
      // Two arcs represent a complete ring without coincident-endpoint SVG
      // ambiguity. Partial arcs retain their authored sweep and direction.
      const segments = Math.max(1, Math.ceil(Math.abs(delta) / 179.99))
      for (let i = 1; i <= segments; i++) {
        const p = point(start + delta * i / segments)
        d += ` A ${radius} ${radius} 0 0 ${delta >= 0 ? 1 : 0} ${p[0]} ${p[1]}`
      }
      content.append(element('path', { ...paint, fill: 'none', 'stroke-linecap': 'round', d }))
    } else if (layer.type === 'path') {
      content.append(element('path', { ...paint, d: layer.path || '' }))
    } else if (layer.type === 'text') {
      const text = element('text', { ...paint, 'data-motion-text': layer.id, 'aria-label': layer.text || '', 'xml:space': 'preserve' })
      const family = layer.font?.family || 'Arial'
      text.style.fontFamily = families[family] || families.Arial
      text.style.fontWeight = String(layer.font?.weight || 700)
      text.style.letterSpacing = `${layer.font?.tracking || 0}px`
      text.style.whiteSpace = 'pre'
      // Scale a single composition, without small-screen font hinting changing
      // the metrics used to wrap and fit the same logical text box.
      text.style.textRendering = 'geometricPrecision'
      content.append(text)
      fitters.push(() => {
        text.removeAttribute('transform')
        let size = layer.font?.size || Math.min(h * .8, w * .25)
        const lineHeight = layer.font?.lineHeight || 1.12
        const availableW = Math.max(1, w - strokeWidth - 2), availableH = Math.max(1, h - strokeWidth - 2)
        const measure = (value: string) => { text.textContent = value; return text.getComputedTextLength() }
        for (let attempt = 0; attempt < 12; attempt++) {
          text.setAttribute('font-size', String(size))
          const lines: string[] = []
          for (const paragraph of (layer.text || '').split('\n')) {
            let line = ''
            for (const token of paragraph.match(/\s+|\S+/g) || []) {
              const next = line + token
              if (line && /\S/.test(token) && measure(next) > availableW) { lines.push(line); line = token } else line = next
            }
            lines.push(line)
          }
          text.replaceChildren()
          lines.forEach((line, i) => {
            const span = element('tspan', { x: 0, y: i * size * lineHeight })
            span.textContent = line; text.append(span)
          })
          const bounds = text.getBBox()
          const factor = Math.min(1, availableW / Math.max(1, bounds.width), availableH / Math.max(1, bounds.height))
          if (factor >= .999 || attempt === 11) {
            const align = layer.align || 'left'
            const x = (align === 'center' ? (w - bounds.width * factor) / 2 : align === 'right' ? w - bounds.width * factor - strokeWidth / 2 - 1 : strokeWidth / 2 + 1) - bounds.x * factor
            const y = (h - bounds.height * factor) / 2 - bounds.y * factor
            text.setAttribute('transform', `translate(${x} ${y}) scale(${factor})`)
            break
          }
          size *= factor * .99
        }
      })
    }
    players.push({ layer, group, clip })
  }
  const render = (timeMs: number) => {
    const time = reduce.matches ? scene.posterTimeMs : spec.loop ? ((timeMs % spec.durationMs) + spec.durationMs) % spec.durationMs : Math.max(0, Math.min(spec.durationMs, timeMs))
    svg.setAttribute('data-motion-time', String(time))
    for (const { layer, group, clip } of players) {
      const pose: MotionPose = poseAt(layer.keyframes, time)
      const { x, y, width: w, height: h } = layer.box
      group.setAttribute('transform', `translate(${x + w / 2 + pose.x} ${y + h / 2 + pose.y}) rotate(${pose.rotate}) scale(${pose.scale}) translate(${-w / 2} ${-h / 2})`)
      group.setAttribute('opacity', String(pose.opacity))
      const direction = layer.revealDirection || 'left'
      const horizontal = direction === 'left' || direction === 'right'
      const width = horizontal ? w * pose.reveal : w, height = horizontal ? h : h * pose.reveal
      clip.setAttribute('x', String(direction === 'right' ? w - width : 0))
      clip.setAttribute('y', String(direction === 'up' ? h - height : 0))
      clip.setAttribute('width', String(width)); clip.setAttribute('height', String(height))
    }
  }
  ;(window as unknown as { naluMotion: object }).naluMotion = { render }
  const tick = (stamp: number) => {
    if (origin === undefined) origin = stamp
    const elapsed = stamp - origin
    render(elapsed)
    if (!reduce.matches && (spec.loop || elapsed < spec.durationMs)) raf = requestAnimationFrame(tick)
  }
  const start = () => { cancelAnimationFrame(raf); origin = undefined; if (!reduce.matches) raf = requestAnimationFrame(tick); else render(scene.posterTimeMs) }
  // Layout measurement uses actual browser glyphs, including offline fallbacks.
  // Refit once fonts settle; no generated CSS, network asset or timer is needed.
  fitters.forEach(fit => fit()); render(0); start()
  Promise.resolve(document.fonts?.ready).then(() => { fitters.forEach(fit => fit()); render(reduce.matches ? scene.posterTimeMs : Number(svg.getAttribute('data-motion-time')) || 0) }).catch(() => {})
  reduce.addEventListener('change', start)
}

export function motionSceneHtml(scene: MotionScene, spec: MotionSceneSpec): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
  const data = JSON.stringify({ scene, spec }).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="en" data-nalu-motion-duration-ms="${spec.durationMs}" data-nalu-motion-width="${spec.width}" data-nalu-motion-height="${spec.height}" data-nalu-motion-loop="${spec.loop}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(scene.name)}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${scene.background}}#nalu-stage{display:block;width:100%;height:100%}</style></head><body><svg id="nalu-stage" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${spec.width} ${spec.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escape(scene.name)}"></svg><script id="nalu-motion-scene" type="application/json">${data}</script><script>const naluScene=JSON.parse(document.getElementById('nalu-motion-scene').textContent);(${motionSceneRuntime.toString()})(naluScene.scene,naluScene.spec,(${motionPoseAt.toString()}));</script></body></html>`
}
