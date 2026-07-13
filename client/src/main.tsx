import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ThemeProvider from './components/ThemeProvider'
import AuthProvider from './components/AuthProvider'
import ResetPassword from './components/ResetPassword'
import './globals.css'

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
