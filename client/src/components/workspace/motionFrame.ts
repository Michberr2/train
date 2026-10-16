export type MotionSpec = { durationMs: number; width: number; height: number; loop: boolean }
export type MotionFrameState = { ready: boolean; playing: boolean; timeMs: number; seekable: boolean; reduced: boolean }
export function resolveMotionSpec(html: string, supplied?: Partial<MotionSpec>): MotionSpec {
  const attr = (name: string) => html.match(new RegExp(`data-nalu-motion-${name}=["']([^"']+)["']`, 'i'))?.[1]
  const number = (value: unknown, fallback: number, min: number, max: number) => { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? n : fallback }
  return {
    durationMs: number(supplied?.durationMs ?? attr('duration-ms'), 8000, 100, 3600000),
    width: number(supplied?.width ?? attr('width'), 1920, 1, 8192),
    height: number(supplied?.height ?? attr('height'), 1080, 1, 8192),
    loop: supplied?.loop ?? attr('loop') !== 'false',
  }
}

// Serialized into the sandbox. All dependencies must stay inside this function.
function motionRuntime(channel: string, spec: MotionSpec, poster: boolean) {
  const send = (state: object) => parent.postMessage({ channel, type: 'motion-state', ...state }, '*')
  const nativeRAF = window.requestAnimationFrame.bind(window)
  const nativeNow = performance.now.bind(performance)
  const nativeTimer = window.setTimeout.bind(window)
  const nativeClear = window.clearTimeout.bind(window)
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  let ready = false, playing = !poster && !reduce.matches, time = 0, previous = nativeNow(), rate = 1, rafUsed = false, timerUsed = false, scriptAnimationUsed = false
  let nextId = 0, driver = 0, lastReport = -1000
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, { due: number; every: number; callback: (...args: any[]) => void; args: any[] }>()
  // Finished animations without fill disappear from getAnimations(). Keep
  // their handles so seeking and replay can restore earlier visible frames.
  const known = new Map<Animation, number>()
  const originalWall = Date.now()
  // A paused RAF loop sees a paused clock, including older generated loops
  // using performance.now/Date.now instead of their RAF timestamp.
  try { Object.defineProperty(performance, 'now', { configurable: true, value: () => time }) } catch { /* RAF timestamps remain controlled */ }
  Date.now = () => originalWall + time
  window.requestAnimationFrame = callback => { rafUsed = true; const id = ++nextId; frames.set(id, callback); return id }
  window.cancelAnimationFrame = id => { frames.delete(id) }
  const schedule = (callback: TimerHandler, delay = 0, every = 0, args: any[]) => {
    const id = ++nextId
    if (typeof callback === 'function') { timerUsed = true; timers.set(id, { due: time + Math.max(1, Number(delay) || 0), every, callback: callback as (...args: any[]) => void, args }) }
    return id
  }
  window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => schedule(callback, delay, 0, args)) as typeof window.setTimeout
  window.setInterval = ((callback: TimerHandler, delay?: number, ...args: any[]) => schedule(callback, delay, Math.max(1, Number(delay) || 0), args)) as typeof window.setInterval
  window.clearTimeout = window.clearInterval = ((id?: number) => { if (id != null) timers.delete(id) }) as typeof window.clearTimeout
  try { localStorage.length } catch {
    const storage = () => { const values = new Map<string, string>(); return { getItem: (k: string) => values.get(String(k)) ?? null, setItem: (k: string, v: string) => { values.set(String(k), String(v)) }, removeItem: (k: string) => { values.delete(String(k)) }, clear: () => values.clear(), key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size } } }
    try { Object.defineProperty(window, 'localStorage', { value: storage() }); Object.defineProperty(window, 'sessionStorage', { value: storage() }) } catch { /* optional generated-page storage */ }
  }
  const hook = () => (window as any).naluMotion
  const seekable = () => typeof hook()?.render === 'function' || (!rafUsed && timers.size === 0 && (known.size > 0 || document.getAnimations().length > 0))
  // Preserve the film endpoint when explicitly seeking there, while repeating
  // its local timeline as playback advances into the next cycle.
  const filmTime = () => spec.loop ? time > 0 && time % spec.durationMs === 0 ? spec.durationMs : time % spec.durationMs : Math.min(time, spec.durationMs)
  const report = () => send({ ready, playing, timeMs: filmTime(), seekable: seekable(), reduced: reduce.matches })
  const draw = () => {
    let count = 0
    for (const [id, timer] of [...timers]) {
      if (timer.due > time || ++count > 1000) continue
      if (timer.every) timer.due = time + timer.every
      else timers.delete(id)
      try { timer.callback(...timer.args) } catch (error) { console.error(error) }
    }
    const callbacks = [...frames.values()]; frames.clear()
    if (typeof hook()?.render !== 'function') for (const callback of callbacks) { try { callback(time) } catch (error) { console.error(error) } }
    if (typeof hook()?.render === 'function') { try { hook().render(spec.loop ? time % spec.durationMs : Math.min(time, spec.durationMs)) } catch (error) { console.error(error) } }
    for (const animation of document.getAnimations()) {
      // Declarative animations present at load belong to the common timeline;
      // dynamically created animations begin at their creation time.
      if (!known.has(animation)) known.set(animation, ready ? time - Number(animation.currentTime || 0) : 0)
      if (!(animation instanceof CSSAnimation)) scriptAnimationUsed = true
    }
    // A declarative CSS film repeats as a whole, including finite animations
    // that have already finished. JS controllers keep their existing absolute
    // clock; using a timer once must not switch modes after that timer fires.
    const repeatCss = spec.loop && !rafUsed && !timerUsed && !scriptAnimationUsed && typeof hook()?.render !== 'function'
    for (const [animation, started] of known) {
      const target = (animation.effect as KeyframeEffect | null)?.target
      if (animation.playState === 'idle' || (target instanceof Element && !target.isConnected)) { known.delete(animation); continue }
      try { animation.pause(); animation.currentTime = Math.max(0, (repeatCss ? filmTime() : time) - started) } catch { known.delete(animation) }
    }
    for (const svg of document.querySelectorAll('svg')) { try { svg.pauseAnimations(); svg.setCurrentTime(time / 1000) } catch { /* no SMIL timeline */ } }
  }
  const tick = (stamp: number) => {
    driver = 0
    if (!playing || !ready) return
    time += Math.max(0, Math.min(100, stamp - previous)) * rate
    previous = stamp
    if (!spec.loop && time >= spec.durationMs) { time = spec.durationMs; playing = false }
    draw()
    if (stamp - lastReport > 100 || !playing) { lastReport = stamp; report() }
    if (playing) driver = nativeRAF(tick)
  }
  const start = () => { if (playing && ready && !driver) { previous = nativeNow(); driver = nativeRAF(tick) } }
  const pause = () => { playing = false; report() }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data?.type !== 'motion-control') return
    if (event.data.command === 'pause') pause()
    if (event.data.command === 'play' && !reduce.matches && !poster) { if (!spec.loop && time >= spec.durationMs) time = 0; playing = true; start(); report() }
    if (event.data.command === 'seek' && seekable() && Number.isFinite(event.data.timeMs)) { playing = false; time = Math.max(0, Math.min(spec.durationMs, event.data.timeMs)); draw(); report() }
    if (event.data.command === 'rate' && [.5, 1, 1.5, 2].includes(event.data.rate)) rate = event.data.rate
    if (event.data.command === 'state') report()
  })
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause() })
  reduce.addEventListener('change', () => { if (reduce.matches) pause(); report() })
  const boot = () => {
    if (ready) return
    draw()
    ready = true
    if (poster && seekable()) { time = spec.durationMs * .55; draw() }
    report(); start()
  }
  const fallback = nativeTimer(boot, 2500)
  document.addEventListener('DOMContentLoaded', () => {
    Promise.resolve(document.fonts?.ready).catch(() => {}).finally(() => { nativeClear(fallback); boot() })
  }, { once: true })
}

export function motionFrameHtml(html: string, channel: string, spec: MotionSpec, poster = false): string {
  const script = `<script>(${motionRuntime.toString()})(${JSON.stringify(channel)},${JSON.stringify(spec)},${poster});<\/script>`
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, head => head + script)
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, root => root + `<head>${script}</head>`)
  return `<!doctype html><html><head>${script}</head><body>${html}</body></html>`
}
