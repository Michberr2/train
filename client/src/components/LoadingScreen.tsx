import { motion } from 'framer-motion'

export default function LoadingScreen() {
  return (
    <motion.div
      className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden"
      style={{
        background:
          'radial-gradient(circle at 50% 50%, rgba(107,159,255,0.08) 0%, rgb(var(--color-background)) 65%)',
      }}
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.9, ease: [0.4, 0, 0.2, 1], delay: 0.4 } }}
    >
      <div className="relative flex flex-col items-center">
        <motion.div
          className="relative"
          style={{ aspectRatio: '1 / 1' }}
          initial={{ width: 120 }}
          animate={{ width: 340 }}
          exit={{
            width: 340,
            transition: { duration: 0 },
          }}
          transition={{ duration: 1.6, ease: [0.22, 0.61, 0.36, 1] }}
        >
          {/* Soft pulsing glow */}
          <motion.div
            className="absolute inset-[-14%] rounded-full"
            style={{
              background:
                'radial-gradient(circle, rgba(107,159,255,0.22) 0%, rgba(107,159,255,0) 70%)',
              filter: 'blur(12px)',
            }}
            animate={{ opacity: [0.55, 1, 0.55], scale: [0.98, 1.05, 0.98] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
            exit={{ opacity: 0, transition: { duration: 0.4 } }}
          />

          <motion.div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                'conic-gradient(from 0deg, rgba(107,159,255,0) 0deg, rgba(107,159,255,0) 210deg, rgba(107,159,255,0.95) 340deg, rgba(107,159,255,0) 360deg)',
              WebkitMask: 'radial-gradient(circle, transparent 64%, black 66%)',
              mask: 'radial-gradient(circle, transparent 64%, black 66%)',
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 2.6, repeat: Infinity, ease: 'linear' }}
            exit={{ opacity: 0, scale: 1.4, transition: { duration: 0.45, ease: 'easeOut' } }}
          />

          <motion.div
            className="absolute inset-[8%] rounded-full"
            style={{
              background:
                'conic-gradient(from 0deg, rgba(255,255,255,0) 0deg, rgba(107,159,255,0.55) 80deg, rgba(255,255,255,0) 170deg)',
              WebkitMask: 'radial-gradient(circle, transparent 71%, black 73%)',
              mask: 'radial-gradient(circle, transparent 71%, black 73%)',
            }}
            animate={{ rotate: -360 }}
            transition={{ duration: 1.9, repeat: Infinity, ease: 'linear' }}
            exit={{ opacity: 0, scale: 1.4, transition: { duration: 0.45, ease: 'easeOut' } }}
          />

          {/* Hairline static ring */}
          <motion.div
            className="absolute inset-[14%] rounded-full"
            style={{ border: '1px solid rgba(107,159,255,0.18)' }}
            exit={{ opacity: 0, scale: 1.6, transition: { duration: 0.45 } }}
          />

          <motion.div
            className="absolute inset-[16%] rounded-full overflow-hidden bg-surface"
            style={{
              boxShadow:
                '0 24px 60px -12px rgba(107, 159, 255, 0.45), inset 0 0 0 1px rgba(255,255,255,0.45)',
            }}
            animate={{ scale: [0.985, 1.015, 0.985] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
            exit={{
              scale: 16,
              opacity: 0,
              transition: { duration: 1.1, ease: [0.85, 0, 0.15, 1], delay: 0.05 },
            }}
          >
            <motion.img
              src="/images/wolf-landscape.png"
              alt="Loading"
              className="w-full h-full object-cover"
              draggable={false}
              animate={{ rotate: 360 }}
              transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
              style={{ willChange: 'transform' }}
            />
          </motion.div>
        </motion.div>

        {/* Caption */}
        <motion.div
          className="mt-10 text-secondary text-[11px] tracking-[0.42em] uppercase font-light select-none"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: [0.35, 1, 0.35], y: 0 }}
          transition={{
            opacity: { duration: 2.6, repeat: Infinity, ease: 'easeInOut' },
            y: { duration: 0.6, ease: 'easeOut' },
          }}
          exit={{ opacity: 0, y: 8, transition: { duration: 0.3 } }}
        >
          Initializing
        </motion.div>
      </div>
    </motion.div>
  )
}
