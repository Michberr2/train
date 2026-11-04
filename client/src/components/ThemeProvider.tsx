import { createContext, useContext, useState, useEffect, useCallback } from 'react'

interface ThemeContextType {
  isDark: boolean
  toggleTheme: (e?: React.MouseEvent) => void
}

interface ViewTransition {
  ready: Promise<void>
  finished: Promise<void>
}

const ThemeContext = createContext<ThemeContextType>({ isDark: false, toggleTheme: () => {} })

export function useTheme() {
  return useContext(ThemeContext)
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(() => {
    try { return localStorage.getItem('nalu-theme') === 'dark' } catch { return false }
  })

  useEffect(() => {
    const restore = () => {
      try { setIsDark(localStorage.getItem('nalu-theme') === 'dark') } catch { /* Keep the current appearance if storage is unavailable. */ }
    }
    const storage = (event: StorageEvent) => { if (event.key === 'nalu-theme' || event.key === null) restore() }
    window.addEventListener('nalu-hydrated', restore)
    window.addEventListener('storage', storage)
    return () => { window.removeEventListener('nalu-hydrated', restore); window.removeEventListener('storage', storage) }
  }, [])
  useEffect(() => { document.documentElement.classList.toggle('dark', isDark) }, [isDark])

  const toggleTheme = useCallback((e?: React.MouseEvent) => {
    const newDark = !isDark
    const x = e ? e.clientX : window.innerWidth / 2
    const y = e ? e.clientY : window.innerHeight / 2

    const applyTheme = () => {
      if (newDark) document.documentElement.classList.add('dark')
      else document.documentElement.classList.remove('dark')
      setIsDark(newDark)
      try { localStorage.setItem('nalu-theme', newDark ? 'dark' : 'light') } catch { /* The selected appearance still works for this visit. */ }
    }

    const doc = document as typeof document & {
      startViewTransition?: (cb: () => void) => ViewTransition
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (doc.startViewTransition && !reduced) {
      const transition = doc.startViewTransition(applyTheme)
      transition.ready.then(() => {
        const radius = Math.hypot(
          Math.max(x, window.innerWidth - x),
          Math.max(y, window.innerHeight - y)
        )
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${radius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 800,
            easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
            pseudoElement: '::view-transition-new(root)',
          }
        )
      }).catch(() => { /* A newer transition can replace this animation. */ })
    } else {
      if (!reduced) document.documentElement.classList.add('theme-transitioning')
      applyTheme()
      setTimeout(() => {
        document.documentElement.classList.remove('theme-transitioning')
      }, 700)
    }
  }, [isDark])

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
