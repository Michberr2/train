import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import NavBar from './components/NavBar'
import HeroSection from './components/HeroSection'
import EmailCapture from './components/EmailCapture'
import BallAndLine from './components/BallAndLine'
import WolfHead from './components/WolfHead'
import PlatformSection from './components/PlatformSection'
import SolutionsSection from './components/SolutionsSection'
import PricingSection from './components/PricingSection'
import LearnSection from './components/LearnSection'
import LoadingScreen from './components/LoadingScreen'
import ControlScreenDemo from './components/ControlScreenDemo'
import Dashboard from './components/Dashboard'
import SignInWithGithub from './components/SignInWithGithub'
import { getPairing } from './lib/nalu-client'

interface NaluUser {
  id: number
  login: string
  name: string
  avatar: string
}

const ADMIN_KEY = 'nalu-admin'
const TOTAL_PAGES = 5
const LOADING_MIN_MS = 1200

const PRELOAD_IMAGES = [
  '/images/wolf-landscape.png',
  '/images/bg-hills-teal.png',
  '/images/bg-beach-rocks.png',
  '/images/bg-meadow-sunset.png',
  '/images/bg-sandy-beach.png',
  '/nalu-logo.png',
]

export default function App() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [direction, setDirection] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [controlMode, setControlMode] = useState(false)
  const [adminEmail, setAdminEmail] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem(ADMIN_KEY)
  })
  // GitHub-authenticated user. Loaded from /api/auth/me on mount; null when
  // unauthenticated. Signed-in users skip the EmailCapture gate entirely.
  const [naluUser, setNaluUser] = useState<NaluUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((data) => {
        if (cancelled) return
        if (data?.user) setNaluUser(data.user as NaluUser)
      })
      .catch(() => { /* silent — fall back to other entry paths */ })
      .finally(() => { if (!cancelled) setAuthChecked(true) })
    return () => { cancelled = true }
  }, [])
  const handleGithubLogout = useCallback(async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }) }
    catch { /* ignore */ }
    setNaluUser(null)
  }, [])

  const handleAdminUnlock = useCallback((email: string) => {
    localStorage.setItem(ADMIN_KEY, email)
    setAdminEmail(email)
  }, [])

  const handleAdminLogout = useCallback(() => {
    localStorage.removeItem(ADMIN_KEY)
    setAdminEmail(null)
  }, [])

  useEffect(() => {
    const start = performance.now()
    let settled = 0
    const total = PRELOAD_IMAGES.length

    const finish = () => {
      const elapsed = performance.now() - start
      const remaining = Math.max(0, LOADING_MIN_MS - elapsed)
      setTimeout(() => setIsLoading(false), remaining)
    }

    PRELOAD_IMAGES.forEach((src) => {
      const img = new Image()
      const done = () => {
        settled += 1
        if (settled === total) finish()
      }
      img.onload = done
      img.onerror = done
      img.src = src
    })
  }, [])
  const isAnimating = useRef(false)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)

  const goTo = useCallback((index: number) => {
    if (isAnimating.current || index === activeIndex || index < 0 || index >= TOTAL_PAGES) return
    isAnimating.current = true
    setDirection(index > activeIndex ? 1 : -1)
    setActiveIndex(index)
    setTimeout(() => { isAnimating.current = false }, 1000)
  }, [activeIndex])

  useEffect(() => {
    let accumulated = 0
    let timeout: ReturnType<typeof setTimeout>
    const threshold = 50

    const handleWheel = (e: WheelEvent) => {
      let target = e.target as HTMLElement | null
      while (target && target !== document.documentElement) {
        const { scrollHeight, clientHeight, scrollTop } = target
        const isScrollable = scrollHeight > clientHeight && getComputedStyle(target).overflowY !== 'hidden'
        if (isScrollable) {
          const scrollingDown = e.deltaY > 0
          const scrollingUp = e.deltaY < 0
          const canScrollDown = scrollTop + clientHeight < scrollHeight - 1
          const canScrollUp = scrollTop > 1
          if ((scrollingDown && canScrollDown) || (scrollingUp && canScrollUp)) return
        }
        target = target.parentElement
      }

      e.preventDefault()
      if (isAnimating.current) return

      accumulated += e.deltaY
      clearTimeout(timeout)
      timeout = setTimeout(() => { accumulated = 0 }, 200)

      if (Math.abs(accumulated) >= threshold) {
        if (accumulated > 0) goTo(activeIndex + 1)
        else goTo(activeIndex - 1)
        accumulated = 0
      }
    }

    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, [activeIndex, goTo])

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      touchStartX.current = e.touches[0].clientX
      touchStartY.current = e.touches[0].clientY
    }
    const handleTouchEnd = (e: TouchEvent) => {
      if (isAnimating.current) return
      const dx = e.changedTouches[0].clientX - touchStartX.current
      const dy = e.changedTouches[0].clientY - touchStartY.current
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) goTo(activeIndex + 1)
        else goTo(activeIndex - 1)
      }
    }
    window.addEventListener('touchstart', handleTouchStart, { passive: true })
    window.addEventListener('touchend', handleTouchEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [activeIndex, goTo])

  const handleSetActiveIndex = useCallback((index: number) => {
    goTo(index)
  }, [goTo])

  const controlTargetIndex = (activeIndex + 1) % TOTAL_PAGES

  const handleControlScreen = useCallback(() => {
    if (controlMode || isAnimating.current) return
    setControlMode(true)
  }, [controlMode])

  const handleControlComplete = useCallback(() => {
    setControlMode(false)
    goTo(controlTargetIndex)
  }, [controlTargetIndex, goTo])

  const slideVariants = {
    enter: (dir: number) => ({ opacity: 0, y: dir > 0 ? 40 : -40, filter: 'blur(8px)' }),
    center: { opacity: 1, y: 0, filter: 'blur(0px)' },
    exit: (dir: number) => ({ opacity: 0, y: dir > 0 ? -40 : 40, filter: 'blur(8px)' }),
  }

  // Three valid entry paths past the guest list, in order of preference:
  //  1) a GitHub OAuth session (httpOnly nalu_session cookie) — the primary
  //     path; users sign in with one click, no install required;
  //  2) the legacy admin email shortcut (localStorage `nalu-admin`); or
  //  3) an existing local Nalu pairing token (localStorage `nalu-pairing`).
  // Returning users who already authenticated by any of these skip EmailCapture.
  if (naluUser || adminEmail || getPairing()) {
    const onLogout = naluUser ? handleGithubLogout : handleAdminLogout
    return <Dashboard onLogout={onLogout} />
  }

  return (
    <>
      <AnimatePresence>{isLoading && <LoadingScreen />}</AnimatePresence>
      <motion.main
        className="h-screen bg-background relative overflow-hidden"
        initial={{ opacity: 0, scale: 1.04 }}
        animate={{ opacity: isLoading ? 0 : 1, scale: isLoading ? 1.04 : 1 }}
        transition={{ duration: 0.9, ease: [0.22, 0.61, 0.36, 1], delay: isLoading ? 0 : 0.55 }}
      >
      <div className="absolute top-0 left-0 right-0 z-20 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
        <NavBar
          activeIndex={activeIndex}
          setActiveIndex={handleSetActiveIndex}
          onControlScreen={handleControlScreen}
          controlActive={controlMode}
        />
      </div>

      <AnimatePresence mode="sync" custom={direction}>
        <motion.div
          key={activeIndex}
          custom={direction}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-0"
        >
          {activeIndex === 0 && (
            <div className="h-screen flex flex-col">
              <div className="h-28 md:h-32 flex-shrink-0" />
              <div className="flex-1 flex flex-col items-center justify-center max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8">
                <HeroSection />
                <EmailCapture
                  setActiveIndex={handleSetActiveIndex}
                  onAdminUnlock={handleAdminUnlock}
                />
                {/* Primary entry path: GitHub sign-in. No install needed —
                 *  the Dashboard works against OpenRouter immediately. Pairing
                 *  with a local Nalu is offered later as an upgrade. */}
                <div className="mt-5 flex items-center gap-3">
                  <div className="h-px flex-1 bg-foreground/10" />
                  <span className="text-[11px] uppercase tracking-wider text-foreground/40">or</span>
                  <div className="h-px flex-1 bg-foreground/10" />
                </div>
                <div className="mt-4 flex justify-center">
                  <SignInWithGithub next="/" />
                </div>
              </div>
            </div>
          )}
          {activeIndex === 1 && <PlatformSection />}
          {activeIndex === 2 && <SolutionsSection />}
          {activeIndex === 3 && <PricingSection />}
          {activeIndex === 4 && <LearnSection />}
        </motion.div>
      </AnimatePresence>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex gap-2">
        {Array.from({ length: TOTAL_PAGES }).map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            aria-label={`Go to page ${i + 1}`}
            className={`w-2 h-2 rounded-full transition-all duration-300 ${
              i === activeIndex ? 'bg-white w-6 shadow-md' : 'bg-white/40 hover:bg-white/60'
            }`}
          />
        ))}
      </div>

        <WolfHead />
        <BallAndLine />
        <AnimatePresence>
          {controlMode && (
            <ControlScreenDemo
              targetIndex={controlTargetIndex}
              onComplete={handleControlComplete}
            />
          )}
        </AnimatePresence>
      </motion.main>
    </>
  )
}
