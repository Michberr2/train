import { motion } from 'framer-motion'

export default function WolfHead() {
  const wolfPositions = [
    { x: 350, delay: 1.4 },
    { x: 650, delay: 2.8 },
  ]

  return (
    <div className="absolute bottom-0 left-0 w-full h-full pointer-events-none z-10">
      {wolfPositions.map((pos, index) => (
        <motion.div
          key={index}
          className="absolute"
          style={{
            left: pos.x,
            bottom: -200,
            width: '200px',
            height: '200px',
          }}
          initial={{ y: 0 }}
          animate={{ y: [0, -115, -115, 0] }}
          transition={{
            duration: 1,
            delay: pos.delay,
            repeat: Infinity,
            repeatDelay: 4,
            ease: 'easeInOut',
            times: [0, 0.3, 0.7, 1],
          }}
        >
          <div style={{ width: '200px', height: '200px', position: 'relative', overflow: 'visible' }}>
            <img
              src="/nalu-logo.png"
              alt="Wolf Head"
              width={600}
              height={200}
              className="absolute"
              style={{
                left: '0px',
                top: '40px',
                clipPath: 'inset(0 62% 0 0)',
                filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.2))',
                transform: 'scale(1.2)',
                transformOrigin: 'left center',
              }}
            />
          </div>
        </motion.div>
      ))}
    </div>
  )
}
