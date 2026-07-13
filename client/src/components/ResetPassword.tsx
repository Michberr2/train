// Full-page password-reset screen, shown at /reset?token=… (the link Nalu emails).
// Reads the one-time token from the URL, lets the user choose a new password, and
// on success signs them in and drops them into the app.
import { useMemo, useState, FormEvent } from 'react'
import * as localAuth from '../lib/localAuth'

const inputCls =
  'w-full px-4 py-3 rounded-xl border border-border-gray bg-background text-primary placeholder-tertiary focus:outline-none focus:border-accent-blue focus:ring-2 focus:ring-accent-blue/20 transition-all duration-200 text-sm'

export default function ResetPassword() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('token') || '', [])
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    try {
      const res = await localAuth.resetPassword(token, password)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setDone(true)
      // signed in now — send them into the app
      setTimeout(() => { window.location.href = '/' }, 1400)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-2xl border border-border-gray bg-surface p-6 shadow-glass-lg">
        <div className="text-[12px] font-bold tracking-[2px] text-accent-blue">NALU</div>
        <h1 className="text-lg font-medium text-primary mt-2 mb-1">Choose a new password</h1>

        {!token ? (
          <>
            <p className="text-sm font-light text-secondary mb-5">
              This reset link is missing its token. Request a new one from the sign-in screen.
            </p>
            <a
              href="/"
              className="inline-block px-6 py-3 rounded-xl bg-primary text-surface font-medium hover:shadow-md transition-all duration-200 text-sm"
            >
              Back to Nalu
            </a>
          </>
        ) : done ? (
          <>
            <p className="text-sm font-light text-secondary mb-2">
              Your password has been updated and you're signed in. Taking you to Nalu…
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-light text-secondary mb-5">
              Enter a new password for your account. This link works once and expires an hour after it was sent.
            </p>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <input
                type="password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                autoFocus
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
              {error && <p className="text-red-500 text-sm">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="mt-1 px-6 py-3 rounded-xl bg-primary text-surface font-medium hover:shadow-md transition-all duration-200 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Updating…' : 'Update password'}
              </button>
            </form>
            <p className="text-tertiary text-xs text-center mt-4">
              <a href="/" className="text-primary border-b border-primary/40 hover:border-primary transition-colors">
                Back to sign in
              </a>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
