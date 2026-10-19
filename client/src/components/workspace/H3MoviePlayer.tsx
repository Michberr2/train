import { useEffect, useRef, useState } from 'react'
import { continueH3Movie, controlH3Movie, isPlanningH3Movie, movieClipUrl, movieIdFromUrl, readH3Movie, type H3Movie } from '../../lib/h3Movie'

/** A local movie is a persisted sequence while rendering, and one MP4 when done. */
export default function H3MoviePlayer({ url, className }: { url: string; className?: string }) {
  const id = movieIdFromUrl(url)
  const [state, setState] = useState<H3Movie | null>(null)
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [fullMovie, setFullMovie] = useState(false)
  const [resuming, setResuming] = useState(false)
  const planner = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!id) return
    setState(null); setError(''); setIndex(0); setFullMovie(false)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await readH3Movie(id, controller.signal)
        if (!controller.signal.aborted) { setState(next); setError('') }
        if (next.status === 'complete') return
      }
      catch { if (!controller.signal.aborted) setError('Reconnect to the H3 runner on the computer that created this movie, and allow local-device access in your browser’s site permissions. Your shots remain saved there.') }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 2000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer); planner.current?.abort() }
  }, [id])

  if (!id) return <video src={url} controls className={className} />
  const clip = state?.clips[index]
  const resume = async () => {
    if (resuming) return
    const controller = new AbortController()
    planner.current = controller
    setResuming(true); setError('')
    try {
      await controlH3Movie(id, 'resume')
      await continueH3Movie(id, { signal: controller.signal, pauseOnAbort: false })
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The movie could not resume.') }
    finally { setResuming(false) }
  }
  const pause = async () => {
    planner.current?.abort()
    try { setState(await controlH3Movie(id, 'pause')) } catch { setError('Could not reach the local H3 runner to pause.') }
  }
  return <div className="my-3 overflow-hidden rounded-xl border border-glass/[0.14] bg-canvas">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-glass/10 px-4 py-3">
      <span className="text-sm font-medium text-ink">{state?.config.title || 'H3 movie'}</span>
      <span className="text-xs text-dim">{state ? `${state.clips.length}/${state.total_shots} shots saved` : 'Connecting to your computer…'}</span>
    </div>
    {fullMovie && state?.status === 'complete'
      ? <video src={url} controls className={className || 'w-full max-h-[32rem] bg-black'} />
      : clip
        ? <video key={clip.index} src={movieClipUrl(clip)} controls autoPlay playsInline onEnded={() => setIndex(value => value + 1)} className={className || 'w-full max-h-[32rem] bg-black'} />
        : <div className="flex min-h-40 items-center justify-center px-6 py-10 text-sm text-dim" role="status">
            {!state ? 'Connecting to your local H3 runner…' : state.status === 'complete' ? 'Your finished movie is ready.' : state.paused ? 'The movie is paused. Your completed shots are saved.' : index > 0 ? 'The next shot is still rendering. Playback will continue when it is ready.' : 'Your opening shot is rendering. Each shot may take minutes or hours, depending on your hardware.'}
          </div>}
    <div className="space-y-2 px-4 py-3">
      <div className="text-xs text-dim" aria-live="polite">{error || state?.error || state?.phase || 'Loading saved movie…'}</div>
      {state && <progress aria-label="Movie generation progress" value={state.completed_frames} max={state.total_frames} className="h-1 w-full accent-current text-gold" />}
      <div className="flex flex-wrap items-center gap-4 text-xs font-medium text-gold">
        {state?.clips.length ? <button type="button" onClick={() => { setFullMovie(false); setIndex(0) }}>Watch saved shots</button> : null}
        {state?.status === 'complete' ? <>
          <button type="button" onClick={() => setFullMovie(true)}>Play finished movie</button>
          <a href={`${url}?download=1`} download="nalu-h3-movie.mp4">Download movie</a>
        </> : state && (state.paused || !isPlanningH3Movie(id)) ? <button type="button" disabled={resuming || isPlanningH3Movie(id)} onClick={() => void resume()}>{resuming ? 'Resuming…' : 'Resume movie'}</button>
          : state ? <button type="button" onClick={() => void pause()}>Pause after this shot</button> : null}
      </div>
      <p className="text-[11px] text-dim">H3 renders and saves each shot on this computer. Story planning uses your Nalu language model.</p>
    </div>
  </div>
}
