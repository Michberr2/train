import { useEffect, useRef } from 'react'
import './nalu-globe.css'

// Evenly distributed points on a sphere. Depth changes their size and opacity;
// rotating the points around the vertical axis keeps this a globe, not a ring.
const POINTS = Array.from({ length: 64 }, (_, index) => {
  const y = 1 - (2 * (index + .5)) / 64
  const radius = Math.sqrt(1 - y * y)
  const longitude = index * Math.PI * (3 - Math.sqrt(5))
  return { x: Math.cos(longitude) * radius, y, z: Math.sin(longitude) * radius }
})
const INITIAL_ANGLE = .35

function project(point: typeof POINTS[number], angle: number) {
  const x = point.x * Math.cos(angle) + point.z * Math.sin(angle)
  const z = point.z * Math.cos(angle) - point.x * Math.sin(angle)
  const depth = (z + 1) / 2
  return { cx: 32 + x * 25, cy: 32 + point.y * 25, r: .7 + depth * .8, opacity: .17 + depth * .8 }
}

/** Decorative activity indicator. Its surrounding status supplies the label. */
export default function NaluGlobe({ size = 24, active = true, className = '' }: {
  size?: number
  active?: boolean
  className?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const svg = ref.current
    if (!svg || !active) return
    const dots = Array.from(svg.querySelectorAll('circle'))
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let visible = true
    let frame = 0
    let lastFrame = 0
    let angle = INITIAL_ANGLE

    const canAnimate = () => visible && !motion.matches && document.visibilityState !== 'hidden'
    const draw = (now: number) => {
      frame = 0
      if (!canAnimate()) return
      // Twenty-four frames per second is plenty for this slow, small indicator.
      // Update SVG attributes directly rather than rerendering the chat tree.
      if (!lastFrame || now - lastFrame >= 1000 / 24) {
        if (lastFrame) angle += Math.min(now - lastFrame, 100) * .00045
        lastFrame = now
        dots.forEach((dot, index) => {
          const point = project(POINTS[index], angle)
          dot.setAttribute('cx', point.cx.toFixed(2))
          dot.setAttribute('cy', point.cy.toFixed(2))
          dot.setAttribute('r', point.r.toFixed(2))
          dot.setAttribute('opacity', point.opacity.toFixed(2))
        })
      }
      frame = requestAnimationFrame(draw)
    }
    const synchronize = () => {
      cancelAnimationFrame(frame)
      frame = 0
      lastFrame = 0
      if (canAnimate()) frame = requestAnimationFrame(draw)
    }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting)
      synchronize()
    })
    observer?.observe(svg)
    motion.addEventListener('change', synchronize)
    document.addEventListener('visibilitychange', synchronize)
    synchronize()
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      motion.removeEventListener('change', synchronize)
      document.removeEventListener('visibilitychange', synchronize)
    }
  }, [active])

  return <svg ref={ref} className={`nalu-globe ${className}`} viewBox="0 0 64 64" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
    {POINTS.map((point, index) => <circle key={index} {...project(point, INITIAL_ANGLE)} />)}
  </svg>
}
