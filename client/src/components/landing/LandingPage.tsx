import { lazy, Suspense, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { AnimatePresence, MotionConfig, motion, useInView, useReducedMotion, useScroll, useTransform, type MotionValue } from 'framer-motion'
import { ArrowDown, ArrowUpRight, Menu, Pause, Play, X } from 'lucide-react'
import { useAuth } from '../AuthProvider'
import LoadingScreen from '../LoadingScreen'
import Scenery from '../Scenery'
import NeuralCore from './NeuralCore'
import Capabilities from './Capabilities'
import NaluMark from './NaluMark'
import './landing.css'

const NaluChase = lazy(() => import('../NaluChase'))
const sections = [{ id: 'meet', name: 'Meet Nalu' }, { id: 'platform', name: 'The core' }, { id: 'possibilities', name: 'Capabilities' }]
const statement = 'A little help. A lot of possibility. Turn the things on your mind into things you can actually use. Think it through. Bring it to life. Make it yours.'
const words = statement.split(' ')

function RevealWord({ word, index, progress, reduced }: { word: string; index: number; progress: MotionValue<number>; reduced: boolean }) {
  const opacity = useTransform(progress, [index / (words.length + 2), (index + 2) / (words.length + 2)], [0, 1])
  return <span className={`nalu-reveal-word ${index < 3 || index > words.length - 5 ? 'is-bold' : ''}`}><span className="nalu-reveal-outline">{word} </span><motion.span aria-hidden="true" className="nalu-reveal-fill" style={{ opacity: reduced ? 1 : opacity }}>{word}</motion.span></span>
}

function ScrollStory({ container, reduced }: { container: RefObject<HTMLDivElement>; reduced: boolean }) {
  const section = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({ container, target: section, offset: ['start start', 'end end'] })
  const sceneScale = useTransform(scrollYProgress, [0, 1], [1.08, 1])
  return <section ref={section} className="nalu-manifesto" data-reduced-motion={reduced} aria-label="A little help. A lot of possibility.">
    <div className="nalu-manifesto-sticky">
      <motion.div className="nalu-scene" style={reduced ? undefined : { scale: sceneScale }}><Scenery src="/images/bg-beach-rocks.png" /></motion.div>
      <div className="nalu-scene-shade" /><div className="nalu-scene-grid" aria-hidden="true" />
      <div className="nalu-manifesto-content">
        <div className="nalu-section-topline"><span>A LITTLE MORE POSSIBILITY</span><div className="nalu-section-rule" /><span>THAT’S NALU.</span></div>
        <h2>{words.map((word, index) => <RevealWord key={index} word={word} index={index} progress={scrollYProgress} reduced={reduced} />)}</h2>
        <span className="nalu-story-caption">YOUR IDEAS. YOUR PACE. YOUR NALU.</span>
      </div>
    </div>
  </section>
}

function Playground({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const visible = useInView(ref, { margin: '100px' })
  return <div ref={ref} className="nalu-landing-playground">{visible && !reduced && <Suspense fallback={null}><NaluChase /></Suspense>}</div>
}

export default function LandingPage() {
  const { openAuth } = useAuth()
  const prefersReduced = useReducedMotion()
  const [paused, setPaused] = useState(false)
  const reduced = !!prefersReduced || paused
  const container = useRef<HTMLDivElement>(null)
  const hero = useRef<HTMLElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [intro, setIntro] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const { scrollYProgress } = useScroll({ container })
  const { scrollYProgress: heroProgress } = useScroll({ container, target: hero, offset: ['start start', 'end start'] })
  const heroY = useTransform(heroProgress, [0, 1], [0, 150])
  const heroScale = useTransform(heroProgress, [0, 1], [1, 1.1])
  const heroOpacity = useTransform(heroProgress, [0, .85], [1, .1])
  const finishIntro = useCallback(() => setIntro(false), [])
  useEffect(() => {
    if (!intro) return
    if (reduced) { finishIntro(); return }
    const timer = window.setTimeout(finishIntro, 1800)
    return () => window.clearTimeout(timer)
  }, [intro, reduced, finishIntro])

  const goTo = useCallback((index: number) => {
    const target = document.getElementById(sections[index]?.id), host = container.current
    if (!target || !host) return
    setMenuOpen(false)
    host.scrollTo({ top: target.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop, behavior: reduced ? 'auto' : 'smooth' })
  }, [reduced])
  useEffect(() => {
    const host = container.current
    if (!host) return
    let frame = 0
    const update = () => {
      frame = 0
      let current = 0
      sections.forEach((section, index) => { if ((document.getElementById(section.id)?.getBoundingClientRect().top ?? Infinity) <= 160) current = index })
      setActiveIndex(current)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    const onHashChange = () => {
      const index = sections.findIndex(section => `#${section.id}` === window.location.hash)
      if (index >= 0) goTo(index)
    }
    host.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('hashchange', onHashChange)
    update(); onHashChange()
    return () => { host.removeEventListener('scroll', onScroll); window.removeEventListener('hashchange', onHashChange); cancelAnimationFrame(frame) }
  }, [goTo])
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); document.getElementById('nalu-menu-toggle')?.focus() } }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
    <div ref={container} className="nalu-landing" data-motion={reduced ? 'reduced' : 'full'}>
      <div {...(intro ? { inert: '' } as Record<string, string> : {})}>
        <a href="#meet" className="nalu-skip-link" onClick={event => { event.preventDefault(); goTo(0); hero.current?.focus() }}>Skip to content</a>
        <header className="nalu-landing-header">
          <a href="#meet" className="nalu-brand" aria-label="Nalu home" onClick={event => { event.preventDefault(); goTo(0) }}><NaluMark /><span>nalu</span></a>
          <nav className="nalu-desktop-navigation" aria-label="Main navigation">{sections.map((section, index) => <a href={`#${section.id}`} key={section.id} aria-current={activeIndex === index ? 'location' : undefined} onClick={event => { event.preventDefault(); goTo(index) }}>{section.name}</a>)}</nav>
          <div className="nalu-header-actions">
            <button className="nalu-motion-toggle" aria-label={paused ? 'Play animations' : 'Pause animations'} aria-pressed={paused} onClick={() => setPaused(!paused)} disabled={!!prefersReduced}><span>MOTION</span><span>{paused || prefersReduced ? 'OFF' : 'ON'}</span>{paused || prefersReduced ? <Play size={10} /> : <Pause size={10} />}</button>
            <button className="nalu-header-signin" onClick={() => openAuth('signin')}>Sign in <ArrowUpRight size={16} /></button>
            <button id="nalu-menu-toggle" className="nalu-menu-toggle" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} aria-controls="nalu-mobile-navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
          </div>
          {menuOpen && <nav id="nalu-mobile-navigation" className="nalu-mobile-navigation" aria-label="Mobile navigation">{sections.map((section, index) => <a key={section.id} href={`#${section.id}`} onClick={event => { event.preventDefault(); goTo(index) }}>{section.name}<ArrowUpRight size={15} /></a>)}</nav>}
          <motion.div className="nalu-reading-progress" style={{ scaleX: scrollYProgress }} />
        </header>
        <main>
          <section id="meet" ref={hero} tabIndex={-1} className="nalu-hero" aria-labelledby="nalu-hero-title">
            <motion.div className="nalu-scene" style={reduced ? undefined : { scale: heroScale }}><Scenery src="/images/bg-hills-teal.png" /></motion.div>
            <div className="nalu-scene-shade" /><div className="nalu-scene-grid" aria-hidden="true" />
            <motion.div className="nalu-hero-content" style={reduced ? undefined : { y: heroY, opacity: heroOpacity }}>
              <span className="nalu-eyebrow">YOUR IDEAS, IN GOOD COMPANY.</span>
              <h1 id="nalu-hero-title"><span>You dream it.</span><strong>Nalu does it.</strong></h1>
              <p>A LITTLE HELP FOR THE THINGS YOU WANT TO DO.<br />FROM THE FIRST IDEA TO THE FINISHED WORK.</p>
              <div className="nalu-hero-actions"><button className="nalu-button-outline" onClick={() => goTo(1)}>EXPLORE THE CORE <ArrowUpRight size={17} /></button><button className="nalu-button-text" onClick={() => openAuth('signup')}>Meet your Nalu <ArrowUpRight size={16} /></button></div>
            </motion.div>
            <div className="nalu-hero-bottom"><span>A LITTLE HELP. A LOT OF POSSIBILITY.</span><button onClick={() => goTo(1)}>SCROLL TO EXPLORE <ArrowDown size={14} /></button><span>01 — 03</span></div>
          </section>
          <ScrollStory container={container} reduced={reduced} />
          <NeuralCore container={container} reduced={reduced} />
          <Capabilities container={container} reduced={reduced} />
          <footer id="start" className="nalu-landing-footer">
            <div className="nalu-scene"><Scenery src="/images/bg-meadow-sunset.png" /></div><div className="nalu-scene-shade" /><div className="nalu-scene-grid" aria-hidden="true" />
            <div className="nalu-footer-content"><span className="nalu-eyebrow">03 / YOUR NEXT MOVE</span><h2>Bring the idea.<br /><strong>Let’s make it happen.</strong></h2><p>The little things. The big plans. Whatever’s on your mind.</p><button className="nalu-button-outline" onClick={() => openAuth('signup')}>LET’S GET STARTED <ArrowUpRight size={18} /></button><button className="nalu-footer-signin" onClick={() => openAuth('signin')}>Already have a Nalu? Sign in.</button></div>
            <Playground reduced={reduced} />
            <div className="nalu-footer-bottom"><a className="nalu-brand" href="#meet" onClick={event => { event.preventDefault(); goTo(0) }} aria-label="Back to Nalu home"><NaluMark /><span>nalu</span></a><span>YOUR IDEAS. YOUR PACE. YOUR NALU.</span><nav aria-label="Policies"><a href="/sms.html">Messaging</a><a href="/privacy.html">Privacy</a>{!reduced && <button onClick={() => { goTo(0); setIntro(true) }}>Replay intro</button>}<button onClick={() => goTo(0)}>Top ↑</button></nav></div>
          </footer>
        </main>
      </div>
      <AnimatePresence>{intro && <motion.div className="nalu-intro-layer" exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .65 }}><LoadingScreen onSkip={finishIntro} /></motion.div>}</AnimatePresence>
    </div>
  </MotionConfig>
}
