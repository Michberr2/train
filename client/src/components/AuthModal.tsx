import { useState, useEffect, useRef, FormEvent } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { X } from 'lucide-react'
import * as localAuth from '../lib/localAuth'
import type { PublicUser } from '../lib/localAuth'
import { AuthBrand, AuthScene } from './landing/AuthSurface'

type Mode = 'signin' | 'signup'

interface Props {
  open: boolean
  mode: Mode
  setMode: (m: Mode) => void
  onClose: () => void
  onAuthed: (user: PublicUser) => void
}

const inputCls = 'nalu-auth-input'

function tabCls(active: boolean) {
  return `nalu-auth-tab ${active ? 'is-active' : ''}`
}

export default function AuthModal({
  open,
  mode,
  setMode,
  onClose,
  onAuthed,
}: Props) {
  const dialog = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
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

  // Keep the scenic page still and keyboard focus inside the open dialog.
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const landing = document.querySelector<HTMLElement>('.nalu-landing')
    const previousInert = landing?.inert ?? false
    const previousOverflow = landing?.style.overflow ?? ''
    if (landing) { landing.inert = true; landing.style.overflow = 'hidden' }
    const frame = requestAnimationFrame(() => dialog.current?.focus({ preventScroll: true }))
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key !== 'Tab' || !dialog.current) return
      const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]'))
      const first = controls[0], last = controls[controls.length - 1]
      if (!first) { e.preventDefault(); return }
      const focused = document.activeElement
      if (e.shiftKey && (focused === first || focused === dialog.current || !dialog.current.contains(focused))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (focused === last || !dialog.current.contains(focused))) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      if (landing) { landing.inert = previousInert; landing.style.overflow = previousOverflow }
      previousFocus?.focus({ preventScroll: true })
    }
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
          className="nalu-auth-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.3 }}
        >
          <div
            className="nalu-auth-backdrop"
            onClick={onClose}
          />
          <motion.div
            ref={dialog}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={recoveryCode ? 'Save your recovery code' : forgot ? 'Reset password' : mode === 'signup' ? 'Create account' : 'Sign in'}
            className="nalu-auth-dialog"
            initial={{ opacity: 0, y: reduced ? 0 : 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduced ? 0 : 12 }}
            transition={{ duration: reduced ? 0 : 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            <AuthScene />
            <div className="nalu-auth-content">
              <AuthBrand />
              <button
                onClick={onClose}
                aria-label="Close"
                className="nalu-auth-close"
              >
                <X size={18} />
              </button>

              <h2 className="nalu-auth-title">
                {recoveryCode
                  ? 'Save your recovery code'
                  : forgot
                    ? 'Reset your password'
                    : mode === 'signup'
                      ? 'Meet your Nalu.'
                      : 'Welcome back.'}
              </h2>
              <p className="nalu-auth-description">
                {recoveryCode
                  ? "This is the only way to reset your password without email. Keep it somewhere safe — you won't see it again."
                  : forgot
                    ? forgotMode === 'code'
                      ? 'Enter the recovery code you saved, then choose a new password.'
                      : "Enter your account email and we'll send you a link to set a new password."
                    : mode === 'signup'
                      ? 'A little help. A lot of possibility. Make room for what’s next.'
                      : 'Your ideas, projects, and next steps. Right where you left them.'}
              </p>

              {recoveryCode ? (
                <div className="nalu-auth-stack">
                  <div className="nalu-auth-recovery">
                    <span>{recoveryCode}</span>
                    <button
                      type="button"
                      onClick={() => { void navigator.clipboard?.writeText(recoveryCode) }}
                      className="nalu-auth-copy"
                    >
                      Copy
                    </button>
                  </div>
                  <p className="nalu-auth-note">
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
                    className="nalu-auth-primary"
                  >
                    I've saved it — continue
                  </button>
                </div>
              ) : forgot ? (
                resetSent ? (
                  <div className="nalu-auth-stack">
                    <p className="nalu-auth-message">
                      If an account exists for <span>{id || 'that email'}</span>, we've sent a
                      password-reset link. Check your inbox (and spam) — the link expires in an hour.
                    </p>
                    <button
                      type="button"
                      onClick={() => { setForgot(false); setResetSent(false) }}
                      className="nalu-auth-primary"
                    >
                      Back to sign in
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="nalu-auth-tabs">
                      <button type="button" onClick={() => { setForgotMode('link'); setError('') }} className={tabCls(forgotMode === 'link')}>Email a link</button>
                      <button type="button" onClick={() => { setForgotMode('code'); setError('') }} className={tabCls(forgotMode === 'code')}>Recovery code</button>
                    </div>
                    <form onSubmit={submitForgot} className="nalu-auth-form">
                      <input
                        type="text"
                        aria-label="Email or username"
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
                            aria-label="Recovery code (e.g. K7QP-2M9X-4WTZ)"
                            placeholder="Recovery code (e.g. K7QP-2M9X-4WTZ)"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            autoComplete="off"
                            required
                            className={inputCls}
                          />
                          <input
                            type="password"
                            aria-label="New password"
                            placeholder="New password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="new-password"
                            required
                            className={inputCls}
                          />
                          <input
                            type="password"
                            aria-label="Confirm new password"
                            placeholder="Confirm new password"
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            autoComplete="new-password"
                            required
                            className={inputCls}
                          />
                        </>
                      )}
                      {error && <p role="alert" className="nalu-auth-error">{error}</p>}
                      <button
                        type="submit"
                        disabled={loading}
                        className="nalu-auth-primary"
                      >
                        {loading
                          ? (forgotMode === 'code' ? 'Resetting…' : 'Sending…')
                          : (forgotMode === 'code' ? 'Reset password' : 'Send reset link')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setForgot(false)}
                        className="nalu-auth-secondary"
                      >
                        Back to sign in
                      </button>
                    </form>
                  </>
                )
              ) : (
              <>
              <div className="nalu-auth-tabs">
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

              <form onSubmit={submit} className="nalu-auth-form">
                {mode === 'signup' && (
                  <input
                    type="text"
                    aria-label="Name (optional)"
                    placeholder="Name (optional)"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    className={inputCls}
                  />
                )}
                <input
                  type="text"
                  aria-label="Email or username"
                  placeholder="Email or username"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  autoComplete="username"
                  required
                  className={inputCls}
                />
                <input
                  type="password"
                  aria-label="Password"
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
                    aria-label="Confirm password"
                    placeholder="Confirm password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    required
                    className={inputCls}
                  />
                )}

                {error && <p role="alert" className="nalu-auth-error">{error}</p>}

                <button
                  type="submit"
                  disabled={loading}
                  className="nalu-auth-primary"
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
                    className="nalu-auth-secondary"
                  >
                    Forgot password?
                  </button>
                )}
              </form>

              <p className="nalu-auth-footer">
                {mode === 'signup' ? (
                  <>
                    Already have an account?{' '}
                    <button
                      type="button"
                      onClick={() => setMode('signin')}
                      className="nalu-auth-link"
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
                      className="nalu-auth-link"
                    >
                      Create an account
                    </button>
                  </>
                )}
              </p>
              </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
