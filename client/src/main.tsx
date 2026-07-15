import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ThemeProvider from './components/ThemeProvider'
import AuthProvider from './components/AuthProvider'
import ResetPassword from './components/ResetPassword'
import './globals.css'

// Stable per-device id, sent as a cookie with every same-origin /api request, so
// anonymous visitors behind ONE shared IP (corporate / campus / carrier NAT) each
// get their own daily quota bucket instead of sharing (and exhausting) one.
try {
  let did = localStorage.getItem('nalu-did')
  if (!did) {
    did = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))
    localStorage.setItem('nalu-did', did)
  }
  document.cookie = `nalu_did=${did}; path=/; max-age=31536000; SameSite=Lax`
} catch { /* private mode / storage blocked — server falls back to an IP+UA hash */ }

// The password-reset link (/reset?token=…) is a standalone page — render it
// instead of the full app so the flow works even when signed out.
const isReset =
  window.location.pathname === '/reset' || new URLSearchParams(window.location.search).has('token')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      {isReset ? (
        <ResetPassword />
      ) : (
        <AuthProvider>
          <App />
        </AuthProvider>
      )}
    </ThemeProvider>
  </React.StrictMode>,
)
