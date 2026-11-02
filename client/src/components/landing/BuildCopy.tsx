import { useLayoutEffect, useRef, useState } from 'react'

/** Visible copy is actually typed; the hidden measure keeps the layout stable. */
export default function BuildCopy({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [progress, setProgress] = useState<number | number[]>(1)
  const words = text.split(/(\s+)/), count = words.filter(word => word.trim()).length
  useLayoutEffect(() => { setProgress(1) }, [text])
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (event: Event) => {
      const next = (event as CustomEvent<number | number[]>).detail
      setProgress(old => JSON.stringify(old) === JSON.stringify(next) ? old : next)
    }
    element.addEventListener('nalu-build-step', update)
    return () => element.removeEventListener('nalu-build-step', update)
  }, [])
  let index = 0
  return <span ref={ref} className="nalu-build-copy" aria-label={text}>{words.map((word, key) => {
    if (!word.trim()) return <span className="nalu-build-space" aria-hidden="true" key={key}>{word}</span>
    const order = index++, letters = Array.isArray(progress) ? progress[order] || 0 : Math.floor(Math.max(0, Math.min(1, (progress - order / Math.max(1, count) * .4) / .6)) * word.length)
    return <span key={key} className="nalu-build-word" data-letters={word.length} aria-hidden="true"><span className="nalu-build-measure">{word}</span><span className="nalu-build-written">{word.slice(0, letters)}</span></span>
  })}</span>
}
