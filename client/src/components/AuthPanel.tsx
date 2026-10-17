import { motion } from 'framer-motion'
import { useAuth } from './AuthProvider'

interface Props {
  setActiveIndex: (index: number) => void
}

const primaryBtn =
  'px-6 py-3.5 rounded-xl bg-primary text-surface font-medium hover:shadow-md transition-all duration-200 text-sm md:text-base whitespace-nowrap'
const secondaryBtn =
  'px-6 py-3.5 rounded-xl bg-surface border border-border-gray text-primary font-medium hover:border-secondary hover:shadow-sm transition-all duration-200 text-sm md:text-base whitespace-nowrap'

function CompanyLink({
  setActiveIndex,
}: {
  setActiveIndex: (index: number) => void
}) {
  return (
    <motion.div
      className="text-center relative z-20"
      initial={{ y: 20 }}
      animate={{ y: 0 }}
      transition={{ delay: 0.8, duration: 0.5 }}
    >
      <button
        onClick={() => setActiveIndex(4)}
        className="text-primary font-light text-xs border-b border-primary hover:text-secondary hover:border-secondary transition-colors py-3 px-2 min-h-[44px]"
      >
        Our Company →
      </button>
    </motion.div>
  )
}

export default function AuthPanel({ setActiveIndex }: Props) {
  const { user, signOut, openAuth } = useAuth()

  if (user) {
    return (
      <div className="flex flex-col items-center gap-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
          className="max-w-md w-full mx-auto px-4 relative z-20"
        >
          <div className="rounded-2xl border border-border-gray bg-surface p-6 text-center shadow-sm">
            <div className="w-11 h-11 rounded-full bg-accent-blue/15 border border-accent-blue/30 flex items-center justify-center mx-auto mb-3 text-accent-blue font-medium text-lg">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
            <h3 className="text-base font-medium text-primary mb-1">
              Welcome back, {user.displayName}
            </h3>
            <p className="text-sm font-light text-secondary mb-4">
              You're signed in.
            </p>
            <button
              onClick={signOut}
              className="text-xs font-light text-secondary border-b border-secondary/40 hover:text-primary hover:border-primary transition-colors py-1"
            >
              Sign out
            </button>
          </div>
        </motion.div>
        <CompanyLink setActiveIndex={setActiveIndex} />
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <motion.div
        className="flex flex-col sm:flex-row gap-3 max-w-md w-full mx-auto px-4 relative z-20"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, duration: 0.5 }}
      >
        <motion.button
          onClick={() => openAuth('signup')}
          className={primaryBtn}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          Create account
        </motion.button>
        <motion.button
          onClick={() => openAuth('signin')}
          className={secondaryBtn}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          Sign in
        </motion.button>
      </motion.div>
      <CompanyLink setActiveIndex={setActiveIndex} />
    </div>
  )
}
