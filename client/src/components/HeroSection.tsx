import { motion } from 'framer-motion'

const fadeInUp = {
  initial: { opacity: 0, y: 30 },
  animate: { opacity: 1, y: 0 },
}

export default function HeroSection() {
  return (
    <motion.div
      className="text-center mb-8 md:mb-12"
      initial="initial"
      animate="animate"
      transition={{ staggerChildren: 0.15, delayChildren: 0.3 }}
    >
      <motion.h1
        className="text-4xl md:text-5xl lg:text-6xl font-light text-primary mb-4 tracking-tight"
        variants={fadeInUp}
        transition={{ duration: 0.8, ease: 'easeOut' }}
      >
        Your AI. Your screen.
      </motion.h1>

      <motion.p
        className="text-base md:text-lg text-secondary max-w-lg mx-auto leading-relaxed"
        variants={fadeInUp}
        transition={{ duration: 0.8, ease: 'easeOut', delay: 0.1 }}
      >
        Nalu takes over your full screen and does any task for you. Clean your inbox, finish your homework, run your day. Then builds you an AI of your own.
      </motion.p>
    </motion.div>
  )
}
