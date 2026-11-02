import { useEffect, useRef, useState } from 'react'

/** Type through the component's real state setter; user input cancels the action. */
export function useAgentTyping(request: { key: number; text: string } | undefined, update: (text: string) => void, finished?: (key: number) => void) {
  const callbacks = useRef({ update, finished }); callbacks.current = { update, finished }
  const controller = useRef<AbortController>()
  const [typing, setTyping] = useState(false)
  const cancel = () => { controller.current?.abort(); setTyping(false) }
  useEffect(() => {
    if (!request) return
    const abort = new AbortController(); controller.current = abort
    const letters = Array.from(request.text), began = performance.now(), duration = Math.min(1800, Math.max(400, letters.length / 80 * 1000))
    setTyping(true); callbacks.current.update('')
    const timer = setInterval(() => {
      if (abort.signal.aborted) { clearInterval(timer); return }
      const progress = Math.min(1, (performance.now() - began) / duration)
      callbacks.current.update(letters.slice(0, Math.floor(progress * letters.length)).join(''))
      if (progress === 1) { clearInterval(timer); setTyping(false); callbacks.current.finished?.(request.key) }
    }, 32)
    return () => { abort.abort(); clearInterval(timer) }
  }, [request?.key])
  return { typing, cancel }
}
