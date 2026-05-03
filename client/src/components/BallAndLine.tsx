import { motion } from 'framer-motion'

export default function BallAndLine() {
  const horizontalAnimation = {
    x: [50, 200, 350, 500, 650, 800, 950, 1100],
    transition: {
      duration: 5,
      repeat: Infinity,
      ease: 'linear',
      times: [0, 0.14, 0.28, 0.42, 0.56, 0.7, 0.84, 1],
    },
  }

  const bounceAnimation = {
    y: [342, 334, 342, 325, 342, 314, 342, 300, 342, 283, 342, 263, 342, 240, 342],
    transition: {
      duration: 5,
      repeat: Infinity,
      ease: [0.25, 0.1, 0.25, 1],
      times: [0, 0.07, 0.14, 0.21, 0.28, 0.35, 0.42, 0.49, 0.56, 0.63, 0.7, 0.77, 0.84, 0.91, 1],
    },
  }

  const pathPoints = horizontalAnimation.x
    .map((x, i) => {
      const bounceIndex = Math.min(i * 2, bounceAnimation.y.length - 1)
      const y = bounceAnimation.y[bounceIndex]
      return `${x},${y}`
    })
    .join(' ')

  return (
    <div className="absolute bottom-0 left-0 w-full h-full pointer-events-none z-20">
      <svg
        className="w-full h-full"
        viewBox="0 0 1200 350"
        preserveAspectRatio="xMidYMax slice"
        style={{ position: 'absolute', bottom: 0 }}
      >
        <motion.polyline
          points={`50,342 ${pathPoints}`}
          stroke="#EFEFEF"
          strokeWidth="1"
          fill="none"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: [0, 0.25, 0.25, 0] }}
          transition={{ duration: 5, repeat: Infinity, ease: 'linear' }}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <motion.g initial={{ x: 50 }} animate={horizontalAnimation}>
          <motion.g animate={bounceAnimation}>
            <ellipse cx="0" cy="6" rx="4" ry="1.5" fill="rgba(0, 0, 0, 0.15)" />
            <circle
              cx="0"
              cy="0"
              r="5"
              fill="#6B9FFF"
              style={{ filter: 'drop-shadow(0 2px 4px rgba(107, 159, 255, 0.3))' }}
            />
            <circle cx="-1.5" cy="-1.5" r="1.5" fill="rgba(255, 255, 255, 0.8)" />
          </motion.g>
        </motion.g>

        <line x1="0" y1="350" x2="1200" y2="350" stroke="#F8F8F8" strokeWidth="1" opacity="0.3" />
      </svg>
    </div>
  )
}
