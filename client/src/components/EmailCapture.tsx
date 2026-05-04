import { useState, FormEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Props {
  setActiveIndex: (index: number) => void
  onAdminUnlock?: (email: string) => void
}

const ADMIN_EMAIL = 'michberr2@gmail.com'

export default function EmailCapture({ setActiveIndex, onAdminUnlock }: Props) {
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [isDuplicate, setIsDuplicate] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setErrorMsg('')
    setIsDuplicate(false)

    const normalized = email.toLowerCase().trim()
    const isAdmin = normalized === ADMIN_EMAIL

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()

      if (!res.ok) {
        setErrorMsg(data.error || 'Something went wrong')
        setIsLoading(false)
        return
      }
      if (isAdmin && onAdminUnlock) {
        onAdminUnlock(normalized)
        return
      }
      if (data.exists) setIsDuplicate(true)
      setIsSubmitted(true)
    } catch {
      setErrorMsg('Network error. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <AnimatePresence mode="wait">
        {isSubmitted ? (
          <motion.div
            key="confirmation"
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
            className="max-w-md w-full mx-auto px-4 relative z-20"
          >
            <div className="rounded-2xl border border-border-gray bg-surface p-6 text-center shadow-sm">
              <div className="w-10 h-10 rounded-full bg-green-50 border border-green-200 flex items-center justify-center mx-auto mb-3">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-600">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h3 className="text-base font-medium text-primary mb-1">
                {isDuplicate ? "You're already on the list" : "You're on the waitlist"}
              </h3>
              <p className="text-sm font-light text-secondary mb-4">
                {isDuplicate
                  ? `We already have ${email} registered. We'll be in touch soon.`
                  : `We'll notify ${email} when early access is available.`}
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => setActiveIndex(4)}
                  className="text-xs font-light text-secondary border-b border-secondary/40 hover:text-primary hover:border-primary transition-colors py-1"
                >
                  Our Company
                </button>
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            className="flex flex-col sm:flex-row gap-3 max-w-md w-full mx-auto px-4 relative z-20"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ delay: 0.6, duration: 0.5 }}
            onSubmit={handleSubmit}
          >
            <input
              type="email"
              placeholder="email@address.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={isLoading}
              className="flex-1 px-5 py-3.5 rounded-xl border border-border-gray bg-surface text-primary placeholder-tertiary focus:outline-none focus:border-accent-blue focus:ring-2 focus:ring-accent-blue/20 transition-all duration-200 text-base disabled:opacity-50"
            />
            <motion.button
              type="submit"
              disabled={isLoading}
              className="px-6 py-3.5 rounded-xl bg-surface border border-border-gray text-primary font-medium hover:border-secondary hover:shadow-sm transition-all duration-200 text-sm md:text-base disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              whileHover={{ scale: isLoading ? 1 : 1.02 }}
              whileTap={{ scale: isLoading ? 1 : 0.98 }}
            >
              {isLoading ? 'joining...' : 'join the waitlist'}
            </motion.button>
          </motion.form>
        )}
      </AnimatePresence>

      {errorMsg && <p className="text-red-500 text-sm text-center">{errorMsg}</p>}

      {!isSubmitted && (
        <motion.div
          className="text-center relative z-20"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 0.5 }}
        >
          <button
            onClick={() => setActiveIndex(4)}
            className="text-primary font-light text-xs border-b border-primary hover:text-secondary hover:border-secondary transition-colors py-3 px-2 min-h-[44px]"
          >
            Our Company →
          </button>
        </motion.div>
      )}
    </div>
  )
}
