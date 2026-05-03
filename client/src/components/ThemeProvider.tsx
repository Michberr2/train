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
  const [isDark, setIsDark] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('nalu-theme')
    const dark = saved === 'dark'
    setIsDark(dark)
    if (dark) document.documentElement.classList.add('dark')
    setMounted(true)
  }, [])

  const toggleTheme = useCallback((e?: React.MouseEvent) => {
    const newDark = !isDark
    const x = e ? e.clientX : window.innerWidth / 2
    const y = e ? e.clientY : window.innerHeight / 2

    const applyTheme = () => {
      if (newDark) document.documentElement.classList.add('dark')
      else document.documentElement.classList.remove('dark')
      setIsDark(newDark)
      localStorage.setItem('nalu-theme', newDark ? 'dark' : 'light')
    }

    const doc = document as typeof document & {
      startViewTransition?: (cb: () => void) => ViewTransition
    }

    if (doc.startViewTransition) {
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
      })
    } else {
      document.documentElement.classList.add('theme-transitioning')
      applyTheme()
      setTimeout(() => {
        document.documentElement.classList.remove('theme-transitioning')
      }, 700)
    }
  }, [isDark])

  if (!mounted) return <>{children}</>

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
