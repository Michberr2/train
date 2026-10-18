// Full-page password-reset screen, shown at /reset?token=… (the link Nalu emails).
// Reads the one-time token from the URL, lets the user choose a new password, and
// on success signs them in and drops them into the app.
import { useMemo, useState, FormEvent } from 'react'
import * as localAuth from '../lib/localAuth'
import { AuthBrand, AuthScene } from './landing/AuthSurface'

const inputCls = 'nalu-auth-input'

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
    <div className="nalu-auth-reset">
      <AuthScene />
      <div className="nalu-auth-reset-card">
        <div className="nalu-auth-content">
        <AuthBrand />
        <h1 className="nalu-auth-title">Choose a new password</h1>

        {!token ? (
          <>
            <p className="nalu-auth-description">
              This reset link is missing its token. Request a new one from the sign-in screen.
            </p>
            <a
              href="/"
              className="nalu-auth-primary"
            >
              Back to Nalu
            </a>
          </>
        ) : done ? (
          <>
            <p className="nalu-auth-description">
              Your password has been updated and you're signed in. Taking you to Nalu…
            </p>
          </>
        ) : (
          <>
            <p className="nalu-auth-description">
              Enter a new password for your account. This link works once and expires an hour after it was sent.
            </p>
            <form onSubmit={submit} className="nalu-auth-form">
              <input
                type="password"
                aria-label="New password"
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
                aria-label="Confirm new password"
                placeholder="Confirm new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                className={inputCls}
              />
              {error && <p role="alert" className="nalu-auth-error">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="nalu-auth-primary"
              >
                {loading ? 'Updating…' : 'Update password'}
              </button>
            </form>
            <p className="nalu-auth-footer">
              <a href="/" className="nalu-auth-link">
                Back to sign in
              </a>
            </p>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
