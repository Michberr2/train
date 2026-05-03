import { motion, useAnimationControls } from 'framer-motion'
import { useEffect, useState } from 'react'
import { MousePointer2 } from 'lucide-react'

interface Props {
  targetIndex: number
  onComplete: () => void
}

const rand = (min: number, max: number) => min + Math.random() * (max - min)

export default function ControlScreenDemo({ targetIndex, onComplete }: Props) {
  const cursorControls = useAnimationControls()
  const [showRipple, setShowRipple] = useState(false)

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const targetEl = document.querySelector<HTMLElement>(
        `[data-nav-index="${targetIndex}"]`,
      )
      if (!targetEl) {
        onComplete()
        return
      }
      const triggerEl = document.querySelector<HTMLElement>('[data-control-trigger="true"]')

      const targetRect = targetEl.getBoundingClientRect()
      const targetX = targetRect.left + targetRect.width / 2
      const targetY = targetRect.top + targetRect.height / 2

      const startRect = triggerEl?.getBoundingClientRect()
      const startX = startRect ? startRect.left + startRect.width / 2 : window.innerWidth * 0.85
      const startY = startRect ? startRect.top + startRect.height / 2 : 60

      const dx = targetX - startX
      const dy = targetY - startY
      const dist = Math.hypot(dx, dy)

      // Perpendicular unit vector for the natural arc
      const perpX = dist === 0 ? 0 : -dy / dist
      const perpY = dist === 0 ? 0 : dx / dist
      const arc = Math.min(140, dist * 0.22)
      // Bias the arc downward visually so the path drops then rises
      const arcDir = perpY > 0 ? 1 : -1

      // Five-point natural path: settle pause, fast cruise, decel, overshoot, correct
      const p1x = startX + dx * 0.18 + perpX * arc * 0.35 * arcDir + rand(-4, 4)
      const p1y = startY + dy * 0.18 + perpY * arc * 0.35 * arcDir + rand(-4, 4)
      const p2x = startX + dx * 0.55 + perpX * arc * 0.55 * arcDir + rand(-6, 6)
      const p2y = startY + dy * 0.55 + perpY * arc * 0.55 * arcDir + rand(-6, 6)
      const p3x = startX + dx * 0.85 + perpX * arc * 0.25 * arcDir + rand(-3, 3)
      const p3y = startY + dy * 0.85 + perpY * arc * 0.25 * arcDir + rand(-3, 3)
      const overshootX = targetX + (dx / dist) * 14
      const overshootY = targetY + (dy / dist) * 14

      cursorControls.set({ x: startX, y: startY, scale: 0.85, opacity: 0 })

      // Fade in at the trigger
      await cursorControls.start({
        opacity: 1,
        scale: 1,
        transition: { duration: 0.22, ease: 'easeOut' },
      })
      if (cancelled) return

      // Tiny human "settle" wobble before launching
      await cursorControls.start({
        x: startX + rand(-3, 3),
        y: startY + rand(-3, 3),
        transition: { duration: 0.18, ease: 'easeInOut' },
      })
      if (cancelled) return

      await cursorControls.start({
        x: [null, p1x, p2x, p3x, overshootX],
        y: [null, p1y, p2y, p3y, overshootY],
        transition: {
          duration: 1.15,
          times: [0, 0.22, 0.58, 0.82, 1],
          ease: [
            [0.5, 0, 0.75, 0.4],
            [0.4, 0.1, 0.55, 0.9],
            [0.4, 0.1, 0.55, 0.9],
            [0.25, 0.6, 0.4, 0.95],
          ],
        },
      })
      if (cancelled) return

      // Correction back to actual target (the overshoot recovery)
      await cursorControls.start({
        x: targetX,
        y: targetY,
        transition: { duration: 0.18, ease: [0.34, 1.2, 0.64, 1] },
      })
      if (cancelled) return

      await new Promise((r) => setTimeout(r, 110))
      if (cancelled) return

      setShowRipple(true)
      await cursorControls.start({
        scale: [1, 0.82, 1],
        transition: { duration: 0.32, ease: 'easeOut' },
      })
      if (cancelled) return

      await new Promise((r) => setTimeout(r, 220))
      if (cancelled) return

      onComplete()
    }

    run()
    return () => {
      cancelled = true
    }
  }, [targetIndex, onComplete, cursorControls])

  return (
    <motion.div
      className="fixed inset-0 z-40 pointer-events-none"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.3 } }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="absolute top-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/75 backdrop-blur-md text-white text-[11px] font-light tracking-[0.2em] uppercase shadow-lg"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.35 }}
      >
        Nalu is taking the screen
      </motion.div>

      <motion.div
        className="absolute top-0 left-0"
        animate={cursorControls}
        style={{ x: 0, y: 0 }}
      >
        <div className="relative -translate-x-2 -translate-y-1">
          <div
            className="absolute -inset-3 rounded-full"
            style={{
              background:
                'radial-gradient(circle, rgba(107,159,255,0.55) 0%, rgba(107,159,255,0) 70%)',
              filter: 'blur(6px)',
            }}
          />
          <MousePointer2
            size={26}
            className="relative text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]"
            fill="white"
            strokeWidth={1.4}
          />
          {showRipple && (
            <motion.div
              key="ripple"
              className="absolute -left-1 -top-1 w-9 h-9 rounded-full border-2 border-white"
              initial={{ scale: 0, opacity: 0.9 }}
              animate={{ scale: 1.7, opacity: 0 }}
              transition={{ duration: 0.55, ease: 'easeOut' }}
            />
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
