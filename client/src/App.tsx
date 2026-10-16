import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import NavBar from './components/NavBar'
import HeroSection from './components/HeroSection'
import AuthPanel from './components/AuthPanel'
import NaluChase from './components/NaluChase'
import PlatformSection from './components/PlatformSection'
import SolutionsSection from './components/SolutionsSection'
import PricingSection from './components/PricingSection'
import LearnSection from './components/LearnSection'
import LoadingScreen from './components/LoadingScreen'
import ControlScreenDemo from './components/ControlScreenDemo'
import { useAuth } from './components/AuthProvider'

const Workspace = lazy(() => import('./components/workspace/Workspace'))

const TOTAL_PAGES = 5
export default function App() {
  const { user, signOut } = useAuth()
  const [activeIndex, setActiveIndex] = useState(0)
  const [direction, setDirection] = useState(0)
  const [playgroundReady, setPlaygroundReady] = useState(false)
  const [controlMode, setControlMode] = useState(false)

  useEffect(() => { setPlaygroundReady(!user) }, [user])

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
    if (user) return
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
    return () => { window.removeEventListener('wheel', handleWheel); clearTimeout(timeout) }
  }, [activeIndex, goTo, user])

  useEffect(() => {
    if (user) return
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
  }, [activeIndex, goTo, user])

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

  // Signed in → the Nalu (Codex-style) workspace. Signed out → the landing pages.
  if (user) {
    return <Suspense fallback={<LoadingScreen />}><Workspace key={user.id} user={user} onLogout={signOut} /></Suspense>
  }

  return (
    <>
      <motion.main
        className="h-screen bg-background relative overflow-hidden"
        initial={false}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        onAnimationComplete={() => setPlaygroundReady(true)}
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
                <AuthPanel setActiveIndex={handleSetActiveIndex} />
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

        <nav aria-label="Policies" className="absolute bottom-5 right-5 z-20 flex gap-4 rounded-full bg-surface/95 px-3 py-1.5 text-[11px] text-nav-text">
          <a href="/sms.html" className="hover:text-primary">Messaging</a>
          <a href="/privacy.html" className="hover:text-primary">Privacy</a>
        </nav>

        {/* Start stalking after the page is visible, so the opening pounce is seen. */}
        {playgroundReady && <NaluChase />}
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
