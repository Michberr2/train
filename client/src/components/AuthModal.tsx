import { useState, useEffect, FormEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import * as localAuth from '../lib/localAuth'
import type { PublicUser } from '../lib/localAuth'

type Mode = 'signin' | 'signup'

interface Props {
  open: boolean
  mode: Mode
  setMode: (m: Mode) => void
  onClose: () => void
  onAuthed: (user: PublicUser) => void
}

const inputCls =
  'w-full px-4 py-3 rounded-xl border border-border-gray bg-background text-primary placeholder-tertiary focus:outline-none focus:border-accent-blue focus:ring-2 focus:ring-accent-blue/20 transition-all duration-200 text-sm'

function tabCls(active: boolean) {
  return `flex-1 px-4 py-2 text-sm rounded-lg transition-all duration-200 ${
    active
      ? 'bg-surface text-primary font-medium shadow-sm'
      : 'text-nav-text hover:text-primary'
  }`
}

export default function AuthModal({
  open,
  mode,
  setMode,
  onClose,
  onAuthed,
}: Props) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('') // recovery code (email-free reset)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [forgot, setForgot] = useState(false) // showing the "reset password" view
  const [forgotMode, setForgotMode] = useState<'link' | 'code'>('link')
  const [resetSent, setResetSent] = useState(false)
  // When a new recovery code is issued (signup / backfill sign-in / code reset) we
  // show it ONCE and hold the user until they've saved it.
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null)
  const [pendingUser, setPendingUser] = useState<PublicUser | null>(null)
  const [pendingToken, setPendingToken] = useState<string | null>(null)

  // Clear transient state whenever the modal opens or the user switches tabs.
  useEffect(() => {
    setError('')
    setPassword('')
    setConfirm('')
    setCode('')
    setForgot(false)
    setForgotMode('link')
    setResetSent(false)
    setRecoveryCode(null)
    setPendingUser(null)
    setPendingToken(null)
  }, [open, mode])

  // Route a successful auth: if a recovery code came back, show it first; else go.
  const finishAuth = (user: PublicUser, recovery?: string) => {
    if (recovery) {
      setRecoveryCode(recovery)
      setPendingUser(user)
      setPendingToken(localAuth.getToken())
    } else {
      onAuthed(user)
    }
  }

  const submitForgot = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (forgotMode === 'code') {
        if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
        if (password !== confirm) { setError('Passwords do not match.'); return }
        const res = await localAuth.resetWithCode(id, code, password)
        if (!res.ok) { setError(res.error); return }
        finishAuth(res.user, res.recoveryCode)
      } else {
        const res = await localAuth.requestReset(id)
        if (!res.ok) { setError('Could not send the reset link. Please try again.'); return }
        setResetSent(true) // always: the server won't say whether the account exists
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (mode === 'signup' && password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      const res =
        mode === 'signup'
          ? await localAuth.signUp(id, password, name)
          : await localAuth.signIn(id, password)
      if (!res.ok) {
        setError(res.error)
        return
      }
      finishAuth(res.user, res.recoveryCode)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={mode === 'signup' ? 'Create account' : 'Sign in'}
            className="relative z-10 w-full max-w-md rounded-2xl border border-border-gray bg-surface p-6 shadow-glass-lg"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute top-4 right-4 flex items-center justify-center w-8 h-8 rounded-lg text-tertiary hover:text-primary hover:bg-border-gray/60 transition-colors"
            >
              <X size={18} />
            </button>

            <h2 className="text-lg font-medium text-primary mb-1">
              {recoveryCode
                ? 'Save your recovery code'
                : forgot
                  ? 'Reset your password'
                  : mode === 'signup'
                    ? 'Create your account'
                    : 'Welcome back'}
            </h2>
            <p className="text-sm font-light text-secondary mb-5">
              {recoveryCode
                ? "This is the only way to reset your password without email. Keep it somewhere safe — you won't see it again."
                : forgot
                  ? forgotMode === 'code'
                    ? 'Enter the recovery code you saved, then choose a new password.'
                    : "Enter your account email and we'll send you a link to set a new password."
                  : mode === 'signup'
                    ? 'Set up an account to get started.'
                    : 'Sign in to continue.'}
            </p>

            {recoveryCode ? (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-2 rounded-xl border border-border-gray bg-background px-4 py-3">
                  <span className="font-mono text-base tracking-widest text-primary select-all">{recoveryCode}</span>
                  <button
                    type="button"
                    onClick={() => { void navigator.clipboard?.writeText(recoveryCode) }}
                    className="shrink-0 text-xs text-accent-blue hover:underline"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-tertiary text-xs">
                  If you ever forget your password, choose “Recovery code” on the reset screen and enter this — no email
                  needed. Lose it? Sign in and you'll get a fresh one.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const u = pendingUser
                    setRecoveryCode(null); setPendingUser(null); setPendingToken(null)
                    if (u && pendingToken && pendingToken === localAuth.getToken()) onAuthed(u)
                    else setError('The account changed. Please sign in again.')
                  }}
                  className="px-6 py-3 rounded-xl bg-primary text-surface font-medium hover:shadow-md transition-all duration-200 text-sm"
                >
                  I've saved it — continue
                </button>
              </div>
            ) : forgot ? (
              resetSent ? (
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-secondary">
                    If an account exists for <span className="text-primary">{id || 'that email'}</span>, we've sent a
                    password-reset link. Check your inbox (and spam) — the link expires in an hour.
                  </p>
                  <button
                    type="button"
                    onClick={() => { setForgot(false); setResetSent(false) }}
                    className="px-6 py-3 rounded-xl bg-primary text-surface font-medium hover:shadow-md transition-all duration-200 text-sm"
                  >
                    Back to sign in
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex gap-1 mb-4 p-1 rounded-xl bg-border-gray/50 border border-border-gray">
                    <button type="button" onClick={() => { setForgotMode('link'); setError('') }} className={tabCls(forgotMode === 'link')}>Email a link</button>
                    <button type="button" onClick={() => { setForgotMode('code'); setError('') }} className={tabCls(forgotMode === 'code')}>Recovery code</button>
                  </div>
                  <form onSubmit={submitForgot} className="flex flex-col gap-3">
                    <input
                      type="text"
                      placeholder="Email or username"
                      value={id}
                      onChange={(e) => setId(e.target.value)}
                      autoComplete="username"
                      required
                      autoFocus
                      className={inputCls}
                    />
                    {forgotMode === 'code' && (
                      <>
                        <input
                          type="text"
                          placeholder="Recovery code (e.g. K7QP-2M9X-4WTZ)"
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          autoComplete="off"
                          required
                          className={inputCls}
                        />
                        <input
                          type="password"
                          placeholder="New password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          autoComplete="new-password"
                          required
                          className={inputCls}
                        />
                        <input
                          type="password"
                          placeholder="Confirm new password"
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                          autoComplete="new-password"
                          required
                          className={inputCls}
                        />
                      </>
                    )}
                    {error && <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>}
                    <button
                      type="submit"
                      disabled={loading}
                      className="mt-1 px-6 py-3 rounded-xl bg-primary text-surface font-medium hover:shadow-md transition-all duration-200 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {loading
                        ? (forgotMode === 'code' ? 'Resetting…' : 'Sending…')
                        : (forgotMode === 'code' ? 'Reset password' : 'Send reset link')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setForgot(false)}
                      className="text-tertiary text-xs text-center hover:text-primary transition-colors"
                    >
                      Back to sign in
                    </button>
                  </form>
                </>
              )
            ) : (
            <>
            <div className="flex gap-1 mb-5 p-1 rounded-xl bg-border-gray/50 border border-border-gray">
              <button
                type="button"
                onClick={() => setMode('signin')}
                className={tabCls(mode === 'signin')}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => setMode('signup')}
                className={tabCls(mode === 'signup')}
              >
                Create account
              </button>
            </div>

            <form onSubmit={submit} className="flex flex-col gap-3">
              {mode === 'signup' && (
                <input
                  type="text"
                  placeholder="Name (optional)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  className={inputCls}
                />
              )}
              <input
                type="text"
                placeholder="Email or username"
                value={id}
                onChange={(e) => setId(e.target.value)}
                autoComplete="username"
                required
                className={inputCls}
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                required
                className={inputCls}
              />
              {mode === 'signup' && (
                <input
                  type="password"
                  placeholder="Confirm password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  className={inputCls}
                />
              )}

              {error && <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="mt-1 px-6 py-3 rounded-xl bg-primary text-surface font-medium hover:shadow-md transition-all duration-200 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading
                  ? 'Please wait…'
                  : mode === 'signup'
                    ? 'Create account'
                    : 'Sign in'}
              </button>
              {mode === 'signin' && (
                <button
                  type="button"
                  onClick={() => { setForgot(true); setError('') }}
                  className="text-tertiary text-xs text-center hover:text-primary transition-colors"
                >
                  Forgot password?
                </button>
              )}
            </form>

            <p className="text-tertiary text-xs text-center mt-4">
              {mode === 'signup' ? (
                <>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => setMode('signin')}
                    className="text-primary border-b border-primary/40 hover:border-primary transition-colors"
                  >
                    Sign in
                  </button>
                </>
              ) : (
                <>
                  New here?{' '}
                  <button
                    type="button"
                    onClick={() => setMode('signup')}
                    className="text-primary border-b border-primary/40 hover:border-primary transition-colors"
                  >
                    Create an account
                  </button>
                </>
              )}
            </p>
            </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
