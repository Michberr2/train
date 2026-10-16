import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { motionFrameHtml, resolveMotionSpec, type MotionFrameState, type MotionSpec } from './motionFrame'
const control = 'rounded-lg border border-glass/20 px-3 py-2 text-xs font-semibold text-ink hover:bg-glass/10 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
const initialState: MotionFrameState = { ready: false, playing: false, timeMs: 0, seekable: false, reduced: false }
export default function MotionPreview({ html, motion, thumbnail = false }: { html: string; motion?: Partial<MotionSpec>; thumbnail?: boolean }) {
  const id = useId()
  const [restart, setRestart] = useState(0)
  const [state, setState] = useState<MotionFrameState>(initialState)
  const [error, setError] = useState('')
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const [speed, setSpeed] = useState(1)
  const frame = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const player = useRef<HTMLDivElement>(null)
  const visible = useRef(true)
  const ready = useRef(false)
  const generation = useRef(0)
  const pendingSeek = useRef<number | null>(null)
  const spec = useMemo(() => resolveMotionSpec(html, motion), [html, motion])
  const channel = useMemo(() => `${id}-${++generation.current}`, [html, spec, restart, id])
  const source = useMemo(() => motionFrameHtml(html, channel, spec, thumbnail), [html, channel, spec, thumbnail])
  const command = (command: string, extra: object = {}) => frame.current?.contentWindow?.postMessage({ channel, type: 'motion-control', command, ...extra }, '*')
  useEffect(() => {
    ready.current = false
    pendingSeek.current = null
    setState(initialState); setError(''); setSpeed(1)
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== channel || event.data?.type !== 'motion-state') return
      const data = event.data
      if (typeof data.ready !== 'boolean' || typeof data.playing !== 'boolean' || !Number.isFinite(data.timeMs)) return
      if (pendingSeek.current !== null) {
        if (Math.abs(data.timeMs - pendingSeek.current) > 1) return
        pendingSeek.current = null
      }
      setState({ ready: data.ready, playing: data.playing, timeMs: Math.max(0, Math.min(spec.durationMs, data.timeMs)), seekable: data.seekable === true, reduced: data.reduced === true })
      ready.current = data.ready
      if (data.ready) setError('')
    }
    window.addEventListener('message', receive)
    const timer = setTimeout(() => { if (!ready.current) setError('The motion preview could not start. Try restarting it.') }, 8000)
    return () => { window.removeEventListener('message', receive); clearTimeout(timer) }
  }, [source, channel, spec.durationMs])
  useEffect(() => {
    const node = stage.current
    if (!node) return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === node) setWidth(entry.contentRect.width)
        if (entry.target === player.current) setHeight(entry.contentRect.height)
      }
    })
    observer.observe(node)
    if (thumbnail && player.current) observer.observe(player.current)
    const visibility = new IntersectionObserver(entries => { visible.current = entries[0].isIntersecting; if (!visible.current) command('pause') })
    visibility.observe(node)
    return () => { observer.disconnect(); visibility.disconnect() }
  }, [channel, thumbnail])
  const ratio = spec.width / spec.height
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  return <div ref={player} className={thumbnail ? 'flex h-full w-full items-center justify-center overflow-hidden' : 'rounded-xl border border-glass/15 bg-black/20 p-3'} aria-label={thumbnail ? undefined : 'Motion player'}>
    <div ref={stage} className="relative mx-auto overflow-hidden bg-[#101218]" style={{ width: '100%', maxWidth: thumbnail ? height * ratio : `min(100%, ${72 * ratio}vh)`, aspectRatio: `${spec.width} / ${spec.height}` }}>
      <iframe ref={frame} srcDoc={source} title={thumbnail ? 'Motion thumbnail' : 'Motion preview'} tabIndex={-1} aria-hidden={thumbnail || undefined}
        sandbox="allow-scripts" scrolling="no" className="absolute left-0 top-0 border-0" style={{ width: spec.width, height: spec.height, transform: `scale(${width / spec.width})`, transformOrigin: 'top left', pointerEvents: thumbnail ? 'none' : undefined }}
        onLoad={() => { command('state'); if (!visible.current || thumbnail) command('pause') }} />
    </div>
    {!thumbnail && <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={control} disabled={!state.ready || state.reduced} onClick={() => { pendingSeek.current = null; command(state.playing ? 'pause' : 'play') }}>{state.playing ? 'Pause' : 'Play'}</button>
        <button className={control} onClick={() => setRestart(value => value + 1)}>Restart</button>
        <label className="flex items-center gap-2 text-xs text-dim">Speed<select aria-label="Playback speed" className="rounded-lg border border-glass/20 bg-canvas px-2 py-2 text-ink" value={speed} disabled={!state.ready || state.reduced} onChange={event => { const value = Number(event.target.value); setSpeed(value); command('rate', { rate: value }) }}>{[.5, 1, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
        <span className="ml-auto text-xs tabular-nums text-dim">{seconds(state.timeMs)} / {seconds(spec.durationMs)} · {spec.loop ? 'Loop' : 'Once'}</span>
        {document.fullscreenEnabled && <button className={control} onClick={() => void player.current?.requestFullscreen().catch(() => setError('Full screen is unavailable in this view.'))}>Full screen</button>}
      </div>
      {state.seekable && !state.reduced && <input className="mt-3 w-full accent-current" aria-label="Animation position" type="range" min={0} max={spec.durationMs} step={10} value={state.timeMs} onChange={event => { const timeMs = Number(event.target.value); pendingSeek.current = timeMs; setState(current => ({ ...current, timeMs, playing: false })); command('seek', { timeMs }) }} />}
      {!state.ready && !error && <p role="status" className="mt-2 text-xs text-dim">Preparing motion preview…</p>}
      {state.reduced && <p className="mt-2 text-xs text-dim">Reduced motion is enabled on your device. Showing a still frame.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
    </>}
  </div>
}
