// Authored vector motion in logical stage coordinates. Runtime code, layout
// fitting, clipping and the playback clock belong to Nalu, not model output.
export type MotionSceneSpec = { width: number; height: number; durationMs: number; loop: boolean }
export type MotionPose = { x: number; y: number; scale: number; rotate: number; opacity: number; reveal: number }
export type MotionKeyframe = Partial<MotionPose> & { timeMs: number; easing?: 'linear' | 'smooth' | 'in' | 'out' | 'overshoot' }
export type MotionLayer = {
  id: string
  type: 'text' | 'rect' | 'circle' | 'arc' | 'path'
  box: { x: number; y: number; width: number; height: number }
  fill: string
  stroke?: string
  strokeWidth?: number
  radius?: number
  startAngle?: number
  endAngle?: number
  path?: string
  text?: string
  font?: { family?: string; weight?: number; size?: number; tracking?: number; lineHeight?: number }
  align?: 'left' | 'center' | 'right'
  revealDirection?: 'left' | 'right' | 'up' | 'down'
  keyframes: MotionKeyframe[]
}
export type MotionScene = {
  version: 1
  name: string
  concept: string
  background: string
  posterTimeMs: number
  layers: MotionLayer[]
}

export const MOTION_SCENE_FONTS = ['Arial', 'Arial Black', 'Georgia', 'Courier New', 'Impact', 'Trebuchet MS'] as const

// This function is serialized into standalone HTML. Keep all its dependencies
// inside its body, and never mutate the authored keyframes.
export function motionPoseAt(keyframes: MotionKeyframe[], timeMs: number): MotionPose {
  const carry = (previous: MotionPose, frame: MotionKeyframe): MotionPose => ({
    x: frame.x ?? previous.x, y: frame.y ?? previous.y,
    scale: frame.scale ?? previous.scale, rotate: frame.rotate ?? previous.rotate,
    opacity: frame.opacity ?? previous.opacity, reveal: frame.reveal ?? previous.reveal,
  })
  let previous: MotionPose = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1, reveal: 1 }
  if (!keyframes.length) return previous
  previous = carry(previous, keyframes[0])
  const time = Number.isFinite(timeMs) ? timeMs : 0
  if (time <= keyframes[0].timeMs) return previous
  for (let index = 1; index < keyframes.length; index++) {
    const frame = keyframes[index], next = carry(previous, frame)
    if (time <= frame.timeMs) {
      const span = frame.timeMs - keyframes[index - 1].timeMs
      let t = span > 0 ? Math.max(0, Math.min(1, (time - keyframes[index - 1].timeMs) / span)) : 1
      if (frame.easing === 'smooth') t = t * t * (3 - 2 * t)
      else if (frame.easing === 'in') t = t * t * t
      else if (frame.easing === 'out') t = 1 - (1 - t) ** 3
      else if (frame.easing === 'overshoot') { const u = t - 1; t = 1 + 2.70158 * u ** 3 + 1.70158 * u ** 2 }
      const lerp = (key: keyof MotionPose) => previous[key] + (next[key] - previous[key]) * t
      return { x: lerp('x'), y: lerp('y'), scale: Math.max(0, lerp('scale')), rotate: lerp('rotate'), opacity: Math.max(0, Math.min(1, lerp('opacity'))), reveal: Math.max(0, Math.min(1, lerp('reveal'))) }
    }
    previous = next
  }
  return previous
}

export function normalizeMotionKeyframes(keyframes: MotionKeyframe[]): MotionKeyframe[] {
  let pose: MotionPose = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1, reveal: 1 }
  return keyframes.map(frame => {
    pose = { x: frame.x ?? pose.x, y: frame.y ?? pose.y, scale: frame.scale ?? pose.scale, rotate: frame.rotate ?? pose.rotate, opacity: frame.opacity ?? pose.opacity, reveal: frame.reveal ?? pose.reveal }
    return { timeMs: frame.timeMs, ...pose, easing: frame.easing ?? 'linear' }
  })
}

type RecordValue = Record<string, unknown>
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const poseKeys = ['x', 'y', 'scale', 'rotate', 'opacity', 'reveal'] as const
const color = (value: unknown, allowNone = false): string | undefined => {
  if (allowNone && value === 'none') return 'none'
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return undefined
  const hex = value.slice(1).toLowerCase()
  return '#' + (hex.length <= 4 ? [...hex].map(char => char + char).join('') : hex)
}
const rgba = (value: string) => value === 'none' ? [0, 0, 0, 0] : [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16), value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1]

// Validate the restricted SVG path language as data. No SVG markup, URLs or
// arbitrary attributes enter the renderer. Curves use local box coordinates.
function validPath(path: string, width: number, height: number): boolean {
  if (!path.length || path.length > 12000) return false
  const tokens: (string | number)[] = []
  const pattern = /[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g
  let end = 0, match: RegExpExecArray | null
  while ((match = pattern.exec(path))) {
    const gap = path.slice(end, match.index)
    if (!/^[\s,]*$/.test(gap)) return false
    const token = match[0]
    if (gap.includes(',') && ((gap.match(/,/g) || []).length !== 1 || typeof tokens[tokens.length - 1] !== 'number' || /^[A-Za-z]$/.test(token))) return false
    tokens.push(/^[A-Za-z]$/.test(token) ? token : Number(token)); end = pattern.lastIndex
  }
  if (!/^\s*$/.test(path.slice(end)) || tokens.length > 2048 || !/^[Mm]$/.test(String(tokens[0]))) return false
  let i = 0, x = 0, y = 0, sx = 0, sy = 0, drew = false
  const sizes: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }
  const inside = (px: number, py: number) => finite(px, -.001, width + .001) && finite(py, -.001, height + .001)
  while (i < tokens.length) {
    const command = tokens[i++]
    if (typeof command !== 'string') return false
    const upper = command.toUpperCase(), relative = command !== upper
    if (upper === 'Z') { x = sx; y = sy; drew = true; continue }
    const size = sizes[upper], start = i
    while (i < tokens.length && typeof tokens[i] === 'number') i++
    if (!size || i === start || (i - start) % size) return false
    for (let p = start; p < i; p += size) {
      const args = tokens.slice(p, p + size) as number[]
      if (args.some(value => !Number.isFinite(value) || Math.abs(value) > 1000000)) return false
      const ox = relative ? x : 0, oy = relative ? y : 0
      if (upper === 'H') { x = ox + args[0]; if (!inside(x, y)) return false }
      else if (upper === 'V') { y = oy + args[0]; if (!inside(x, y)) return false }
      else if (upper === 'A') {
        if (args[0] < 0 || args[1] < 0 || args[0] > Math.max(width, height) || args[1] > Math.max(width, height) || ![0, 1].includes(args[3]) || ![0, 1].includes(args[4])) return false
        x = ox + args[5]; y = oy + args[6]; if (!inside(x, y)) return false
      } else {
        for (let j = 0; j < args.length; j += 2) if (!inside(ox + args[j], oy + args[j + 1])) return false
        x = ox + args[args.length - 2]; y = oy + args[args.length - 1]
        if (upper === 'M' && p === start) { sx = x; sy = y }
      }
      if (upper !== 'M' || p > start) drew = true
    }
  }
  return drew
}

type Bounds = { left: number; top: number; right: number; bottom: number }
export function motionLayerBounds(layer: MotionLayer, pose: MotionPose): Bounds {
  const angle = pose.rotate * Math.PI / 180
  const width = (Math.abs(Math.cos(angle)) * layer.box.width + Math.abs(Math.sin(angle)) * layer.box.height) * pose.scale
  const height = (Math.abs(Math.sin(angle)) * layer.box.width + Math.abs(Math.cos(angle)) * layer.box.height) * pose.scale
  const cx = layer.box.x + layer.box.width / 2 + pose.x, cy = layer.box.y + layer.box.height / 2 + pose.y
  return { left: cx - width / 2, top: cy - height / 2, right: cx + width / 2, bottom: cy + height / 2 }
}
const intersects = (a: Bounds, b: Bounds) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .01 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .01
const contains = (a: Bounds, b: Bounds) => a.left <= b.left + .01 && a.top <= b.top + .01 && a.right >= b.right - .01 && a.bottom >= b.bottom - .01

export function validateMotionScene(raw: unknown, spec: MotionSceneSpec): { scene?: MotionScene; issues: string[] } {
  const issues: string[] = []
  let issueCount = 0
  const issue = (where: string, message: string) => { issueCount++; if (issues.length < 80) issues.push(`${where}: ${message}`) }
  const keys = (record: RecordValue, allowed: string[], where: string) => {
    for (const key of Object.keys(record)) if (!allowed.includes(key)) issue(where, `unsupported field ${key}`)
  }
  if (!object(spec) || !finite(spec.width, 1, 8192) || !finite(spec.height, 1, 8192) || !finite(spec.durationMs, 100, 3600000) || typeof spec.loop !== 'boolean') return { issues: ['spec: invalid stage dimensions, duration or loop mode'] }
  if (!object(raw)) return { issues: ['scene: expected an object'] }
  keys(raw, ['version', 'name', 'concept', 'background', 'posterTimeMs', 'layers'], 'scene')
  if (raw.version !== 1) issue('scene.version', 'must equal1')
  for (const key of ['name', 'concept']) if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > (key === 'name' ? 160 : 2000)) issue(`scene.${key}`, 'must be a nonempty bounded string')
  const background = color(raw.background)
  if (!background || rgba(background)[3] !== 1) issue('scene.background', 'must be an opaque hex color')
  if (!finite(raw.posterTimeMs, 0, spec.durationMs)) issue('scene.posterTimeMs', 'must be inside the film timeline')
  if (!Array.isArray(raw.layers) || !raw.layers.length || raw.layers.length > 40) return { issues: [...issues, 'scene.layers: expected1–40 layers'] }
  const layers: MotionLayer[] = [], ids = new Set<string>()
  // Preserve original stacking order for diagnostics. An invalid radius does
  // not invalidate an otherwise known box, paint and clock. Unknown core data
  // stays unknown, so excluded layers cannot create false contrast certainty.
  const paintSources: Array<MotionLayer | undefined> = []
  const layerIndices = new Map<MotionLayer, number>()
  const coordinateLimit = 8 * Math.max(spec.width, spec.height)
  for (const [index, input] of raw.layers.entries()) {
    const where = `layers[${index}]`, before = issueCount
    paintSources[index] = undefined
    if (!object(input)) { issue(where, 'expected an object'); continue }
    keys(input, ['id', 'type', 'box', 'fill', 'stroke', 'strokeWidth', 'radius', 'startAngle', 'endAngle', 'path', 'text', 'font', 'align', 'revealDirection', 'keyframes'], where)
    if (typeof input.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.id)) issue(where, 'id must be a simple identifier')
    else if (ids.has(input.id)) issue(where, `duplicate id ${input.id}`)
    else ids.add(input.id)
    const type = input.type as MotionLayer['type']
    if (!['text', 'rect', 'circle', 'arc', 'path'].includes(type)) issue(where, 'unsupported layer type')
    if (!object(input.box)) { issue(where, 'box must be an object'); continue }
    keys(input.box, ['x', 'y', 'width', 'height'], `${where}.box`)
    const box = input.box as MotionLayer['box']
    if (!finite(box.x, -coordinateLimit, coordinateLimit) || !finite(box.y, -coordinateLimit, coordinateLimit) || !finite(box.width, .1, coordinateLimit) || !finite(box.height, .1, coordinateLimit)) { issue(where, 'box coordinates and dimensions must be finite and bounded'); continue }
    const fill = color(input.fill, true), stroke = input.stroke === undefined ? undefined : color(input.stroke, true)
    if (!fill || (input.stroke !== undefined && !stroke)) issue(where, 'paint must be a hex color or none')
    const strokeWidth = input.strokeWidth ?? (stroke && stroke !== 'none' ? 1 : 0)
    if (!finite(strokeWidth, 0, Math.min(box.width, box.height))) issue(where, 'strokeWidth must fit the box')
    if (input.strokeWidth !== undefined && (!stroke || stroke === 'none') && input.strokeWidth !== 0) issue(where, 'strokeWidth needs a visible stroke')
    if (input.revealDirection !== undefined && !['left', 'right', 'up', 'down'].includes(String(input.revealDirection))) issue(where, 'revealDirection must be one of left, right, up, down; aliases such as top/bottom are not supported')
    if (input.radius !== undefined) {
      const cap = Math.min(box.width, box.height) / 2 - (typeof strokeWidth === 'number' ? strokeWidth / 2 : 0)
      if (!['rect', 'circle', 'arc'].includes(type) || !finite(input.radius, 0, cap)) issue(where, 'radius must fit its shape box and stroke')
    }
    if (type === 'arc') {
      if (!finite(input.startAngle, -1440, 1440) || !finite(input.endAngle, -1440, 1440) || input.startAngle === input.endAngle || Math.abs(Number(input.endAngle) - Number(input.startAngle)) > 360) issue(where, 'arc needs distinct finite startAngle and endAngle with a sweep of at most360 degrees')
      const radius = input.radius ?? (Math.min(box.width, box.height) - Number(strokeWidth)) / 2
      if (!stroke || rgba(stroke)[3] === 0 || !finite(strokeWidth, .01, Math.min(box.width, box.height)) || !finite(radius, .01, coordinateLimit)) issue(where, 'arc needs a visible stroke and positive radius')
      if (fill !== 'none') issue(where, 'arc fill must be none; its color comes from stroke')
    } else if (input.startAngle !== undefined || input.endAngle !== undefined) issue(where, 'angles only apply to arcs')
    if (type === 'path') {
      if (typeof input.path !== 'string' || !validPath(input.path, box.width, box.height)) issue(where, 'path must use valid bounded local SVG path commands')
    } else if (input.path !== undefined) issue(where, 'path data only applies to path layers')
    let font: MotionLayer['font']
    if (type === 'text') {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) issue(where, 'text must be a nonempty literal string without control characters')
      if (input.align !== undefined && !['left', 'center', 'right'].includes(String(input.align))) issue(where, 'invalid text alignment')
      const value = input.font ?? {}
      if (!object(value)) issue(where, 'font must be an object')
      else {
        keys(value, ['family', 'weight', 'size', 'tracking', 'lineHeight'], `${where}.font`)
        if (value.family !== undefined && !(MOTION_SCENE_FONTS as readonly unknown[]).includes(value.family)) issue(where, `font family must be one of ${MOTION_SCENE_FONTS.join(', ')}`)
        if (value.weight !== undefined && (!finite(value.weight, 100, 900) || !Number.isInteger(value.weight))) issue(where, 'font weight must be an integer100–900')
        if (value.size !== undefined && !finite(value.size, 1, coordinateLimit)) issue(where, 'font size must be finite and positive')
        if (value.tracking !== undefined && !finite(value.tracking, -100, 200)) issue(where, 'font tracking must be finite and bounded')
        if (value.lineHeight !== undefined && !finite(value.lineHeight, .9, 3)) issue(where, 'lineHeight must be a ratio0.9–3')
        font = { family: 'Arial', lineHeight: 1.12, ...(value as MotionLayer['font']) }
      }
      if (fill && rgba(fill)[3] === 0 && (!stroke || rgba(stroke)[3] === 0 || !strokeWidth)) issue(where, 'text needs visible paint')
    } else if (input.text !== undefined || input.font !== undefined || input.align !== undefined) issue(where, 'text/font/align only apply to text layers')
    const frames: MotionKeyframe[] = []
    const beforeFrames = issueCount
    if (!Array.isArray(input.keyframes) || input.keyframes.length < 2 || input.keyframes.length > 32) issue(where, 'keyframes must contain2–32 frames including both endpoints')
    else for (const [frameIndex, frame] of input.keyframes.entries()) {
      const location = `${where}.keyframes[${frameIndex}]`
      if (!object(frame)) { issue(location, 'expected an object'); continue }
      keys(frame, ['timeMs', 'easing', ...poseKeys], location)
      if (!finite(frame.timeMs, 0, spec.durationMs) || (frameIndex > 0 && (!object(input.keyframes[frameIndex - 1]) || Number(input.keyframes[frameIndex - 1].timeMs) >= Number(frame.timeMs)))) issue(location, 'timeMs must be finite, inside the film and strictly increasing')
      if (frame.easing !== undefined && !['linear', 'smooth', 'in', 'out', 'overshoot'].includes(String(frame.easing))) issue(location, 'unsupported easing')
      for (const key of poseKeys) if (frame[key] !== undefined) {
        const range = key === 'opacity' || key === 'reveal' ? [0, 1] : key === 'scale' ? [0, 8] : key === 'rotate' ? [-3600, 3600] : [-coordinateLimit, coordinateLimit]
        if (!finite(frame[key], range[0], range[1])) issue(location, `${key} must be finite and inside ${range.join('..')}`)
      }
      frames.push(frame as MotionKeyframe)
    }
    if (frames[0]?.timeMs !== 0 || frames[frames.length - 1]?.timeMs !== spec.durationMs) issue(where, 'keyframes must start at0 and end at durationMs')
    if (issueCount !== beforeFrames) continue
    const keyframes = normalizeMotionKeyframes(frames)
    if (!fill || (input.stroke !== undefined && !stroke) || !finite(strokeWidth, 0, Math.min(box.width, box.height)) || !['text', 'rect', 'circle', 'arc', 'path'].includes(type)) continue
    const parsed = { ...(input as MotionLayer), box: { ...box }, fill, ...(stroke ? { stroke } : {}), strokeWidth, ...(font ? { font } : {}), keyframes }
    paintSources[index] = parsed
    if (issueCount !== before) continue
    if (spec.loop && poseKeys.some(key => {
      const delta = Math.abs(Number(keyframes[0][key]) - Number(keyframes[keyframes.length - 1][key]))
      return key === 'rotate' ? Math.min(delta % 360, 360 - delta % 360) > .000001 : delta > .000001
    })) issue(where, 'loop endpoint effective poses must match (rotation may differ by complete turns)')
    layers.push(parsed); layerIndices.set(parsed, index)
  }
  // A malformed top-level timeline cannot support meaningful pose diagnostics.
  // Other independent schema errors must not hide valid text layout problems.
  if (raw.version !== 1 || !finite(raw.posterTimeMs, 0, spec.durationMs)) return { issues }
  if (layers.length === raw.layers.length && !layers.some(layer => layer.keyframes.slice(1).some((frame, index) => poseKeys.some(key => frame[key] !== layer.keyframes[index][key])))) issue('scene.layers', 'at least one actual animated pose change is required')
  const poster = raw.posterTimeMs as number
  const textLayers = layers.filter(layer => layer.type === 'text')
  const readable = (pose: MotionPose) => pose.opacity >= .99 && pose.reveal >= .99 && pose.scale >= .5
  for (const layer of textLayers) if (!readable(motionPoseAt(layer.keyframes, poster))) issue(layer.id, 'all text must be fully readable at posterTimeMs (opacity/reveal>=0.99, scale>=0.5)')
  if (!spec.loop) for (const layer of textLayers) if (!readable(motionPoseAt(layer.keyframes, spec.durationMs))) issue(layer.id, 'one-shot final frame must hold all text fully readable')
  // Check the poster and every sampled fully assembled composition. Entrances
  // and exits may leave the stage; they do not need to fit before full reveal.
  const times = new Set<number>([poster])
  for (const layer of textLayers) for (let index = 0; index < layer.keyframes.length; index++) {
    const t = layer.keyframes[index].timeMs; times.add(t)
    if (index) { const a = layer.keyframes[index - 1].timeMs; for (let step = 1; step < 16; step++) times.add(a + (t - a) * step / 16) }
  }
  const reported = new Set<string>()
  for (const time of times) {
    const poses = textLayers.map(layer => motionPoseAt(layer.keyframes, time))
    if (time !== poster && !poses.every(readable)) continue
    const bounds = textLayers.map((layer, index) => motionLayerBounds(layer, poses[index]))
    for (let i = 0; i < textLayers.length; i++) {
      const layer = textLayers[i], box = bounds[i]
      if (!contains({ left: 0, top: 0, right: spec.width, bottom: spec.height }, box) && !reported.has(layer.id)) { issue(layer.id, 'fully visible hero text leaves the stage'); reported.add(layer.id) }
      for (let j = 0; j < i; j++) {
        const key = `${textLayers[j].id}/${layer.id}`
        if (intersects(box, bounds[j]) && !reported.has(key)) { issue(key, 'fully visible hero text boxes overlap'); reported.add(key) }
      }
    }
  }
  // Sparse arcs/path bounds do not provide a continuous text background. A
  // low-contrast palette needs an authored backplate covering the whole text
  // box; never infer glyph coverage from an intersecting decorative shape.
  // Unknown core paint remains undecidable until a valid full backplate covers
  // it, preserving independent diagnostics for malformed neighboring layers.
  const luminance = (rgb: number[]) => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const coversText = (layer: MotionLayer, pose: MotionPose, box: Bounds) => {
    if (!['rect', 'circle'].includes(layer.type) || pose.scale <= 0 || pose.opacity !== 1 || pose.reveal !== 1 || rgba(layer.fill)[3] !== 1) return false
    const angle = pose.rotate * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle)
    const w = layer.box.width, h = layer.box.height, stroke = layer.strokeWidth || 0
    const cx = layer.box.x + w / 2 + pose.x, cy = layer.box.y + h / 2 + pose.y
    // Inverse-transform the conservative world-space text corners into the
    // backplate's local coordinates. All four must lie in its filled interior.
    return [[box.left, box.top], [box.right, box.top], [box.right, box.bottom], [box.left, box.bottom]].every(([x, y]) => {
      const dx = (x - cx) / pose.scale, dy = (y - cy) / pose.scale
      const localX = c * dx + s * dy, localY = -s * dx + c * dy
      if (layer.type === 'circle') {
        const radius = (layer.radius ?? (Math.min(w, h) - stroke) / 2) - stroke / 2
        return radius > 0 && localX * localX + localY * localY <= radius * radius + .000001
      }
      // The renderer insets the stroke by half its width. Rounded corners need
      // extra padding; the central rectangular interior is a safe subset.
      const inset = Math.max(stroke, (layer.radius || 0) + stroke / 2)
      return Math.abs(localX) <= w / 2 - inset + .000001 && Math.abs(localY) <= h / 2 - inset + .000001
    })
  }
  for (const layer of textLayers) {
    const textPose = motionPoseAt(layer.keyframes, poster), textBox = motionLayerBounds(layer, textPose)
    let certain = !!background && rgba(background)[3] === 1
    let backdrop = background ? rgba(background).slice(0, 3) : [0, 0, 0]
    for (let i = 0; i < layerIndices.get(layer)!; i++) {
      const candidate = paintSources[i]
      if (!candidate) { certain = false; continue }
      const pose = motionPoseAt(candidate.keyframes, poster)
      if (layerIndices.has(candidate) && coversText(candidate, pose, textBox)) {
        backdrop = rgba(candidate.fill).slice(0, 3); certain = true
      }
    }
    if (!certain || layer.fill === 'none' || (layer.stroke && layer.stroke !== 'none' && layer.strokeWidth)) continue
    const ink = rgba(layer.fill), opacity = ink[3] * textPose.opacity
    const foreground = ink.slice(0, 3).map((value, index) => value * opacity + backdrop[index] * (1 - opacity))
    const fg = luminance(foreground), bg = luminance(backdrop)
    const contrast = (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05)
    if (contrast < 3) issue(layer.id, 'poster text contrast is below3:1 against its continuous background. Keep the palette: use a contrasting palette color or add an opaque contrasting rect covering the full text box; intersecting arcs/paths are not a backplate')
  }
  if (issues.length) return { issues }
  return { scene: { version: 1, name: raw.name as string, concept: raw.concept as string, background: background!, posterTimeMs: poster, layers }, issues }
}
