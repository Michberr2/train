import { useEffect, useRef, useState, type RefObject } from 'react'
import { motion, useMotionValueEvent, useScroll, useTransform } from 'framer-motion'
import { ArrowDown, ArrowUpRight } from 'lucide-react'
import { useAuth } from '../AuthProvider'
import Scenery from '../Scenery'

const capabilities = [
  { name: 'Data Engineering', title: 'Data Engineering', description: 'Bring your data together. Clean it up, shape it, and turn scattered files and sources into something you can actually work with.', tags: 'DATA · PIPELINES · TRANSFORMATIONS' },
  { name: 'AI Engineering', title: 'AI Engineering', description: 'Build AI around the way you work. From models and agents to useful tools, Nalu helps you go from an idea to a working system.', tags: 'MODELS · AGENTS · TRAINING · EVALUATION' },
  { name: 'Autopilot', title: 'Autopilot', description: 'Give Nalu the goal. Connect agents, tools, and actions into a workflow, follow each run, and pick up where you left off. Less moving work around. More getting it done.', tags: 'AGENTS · WORKFLOWS · TOOLS · RUNS' },
  { name: 'Studio', title: 'Studio', description: 'Turn an idea into something you can open, edit, and share. Build documents, presentations, spreadsheets, images, and video with your context already in the conversation.', tags: 'DOCUMENTS · SLIDES · DATA · MEDIA' },
  { name: 'Workspace', title: 'Workspace', description: 'Your conversations, files, projects, and tasks, together. Keep the context with the work and continue with Nalu across the web, desktop, and mobile.', tags: 'PROJECTS · CONTEXT · TASKS · SYNC' },
]

export default function Capabilities({ container, reduced }: { container: RefObject<HTMLDivElement>; reduced: boolean }) {
  const { openAuth } = useAuth()
  const section = useRef<HTMLElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [distance, setDistance] = useState(0)
  const [active, setActive] = useState(0)
  const [compact, setCompact] = useState(() => window.matchMedia('(max-height: 700px) and (max-width: 900px)').matches)
  const staticMode = reduced || compact
  const { scrollYProgress } = useScroll({ container, target: section, layoutEffect: false, offset: ['start start', 'end end'] })
  const x = useTransform(scrollYProgress, [0, 1], [0, -distance])
  useMotionValueEvent(scrollYProgress, 'change', value => { if (!staticMode) setActive(Math.round(value * (capabilities.length - 1))) })
  useEffect(() => {
    const el = track.current
    if (!el) return
    const measure = () => {
      const card = el.firstElementChild as HTMLElement | null
      if (card) setDistance((card.offsetWidth + parseFloat(getComputedStyle(el).columnGap)) * (capabilities.length - 1))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const query = window.matchMedia('(max-height: 700px) and (max-width: 900px)')
    const update = () => setCompact(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const select = (index: number) => {
    const host = container.current, target = section.current
    if (!host || !target) return
    if (staticMode) {
      setActive(index)
      document.getElementById(`nalu-capability-${index}`)?.scrollIntoView({ block: 'center', behavior: 'auto' })
      return
    }
    const top = target.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
    host.scrollTo({ top: top + (target.offsetHeight - host.clientHeight) * (index / (capabilities.length - 1)), behavior: 'smooth' })
  }
  return <section id="possibilities" ref={section} className="nalu-capabilities" data-reduced-motion={staticMode} aria-labelledby="nalu-capabilities-title">
    <div className="nalu-capabilities-sticky">
      <div className="nalu-scene"><Scenery src="/images/bg-meadow-sunset.png" /></div><div className="nalu-scene-shade" /><div className="nalu-scene-grid" aria-hidden="true" />
      <div className="nalu-capabilities-content">
        <div className="nalu-section-topline"><span>02 / WHAT NALU CAN DO</span><div className="nalu-section-rule" /><span className="nalu-scroll-direction">{staticMode ? 'EXPLORE THE POSSIBILITIES' : 'KEEP SCROLLING'} <ArrowDown size={12} /></span></div>
        <h2 id="nalu-capabilities-title">Engineered for<br /><strong>what’s next.</strong></h2>
        <div className="nalu-capabilities-window">
          <motion.div ref={track} className="nalu-capabilities-track" style={staticMode ? { x: 0 } : { x }}>
            {capabilities.map((item, index) => <article id={`nalu-capability-${index}`} key={item.name} className={`nalu-capability-card ${active === index || staticMode ? 'is-active' : ''}`} aria-label={item.name}>
              <div className="nalu-capability-meta"><span>0{index + 1}</span><span>{item.tags}</span></div>
              <div className="nalu-capability-copy"><h3><span>{item.title}</span><span aria-hidden="true" className="nalu-capability-title-fill">{item.title}</span></h3><p>{item.description}</p></div>
              <button onClick={() => openAuth('signup')} className="nalu-capability-cta" aria-label={`Try ${item.name.toLowerCase()} with Nalu`}>TRY IT WITH NALU <ArrowUpRight size={14} /></button>
              <span className="nalu-capability-number" aria-hidden="true">0{index + 1}</span>
            </article>)}
          </motion.div>
        </div>
        <nav className="nalu-capability-rail" aria-label="Explore Nalu capabilities">
          <div className="nalu-capability-rail-line" aria-hidden="true"><motion.span style={{ scaleX: staticMode ? 1 : scrollYProgress }} /></div>
          {capabilities.map((item, index) => <button key={item.name} onClick={() => select(index)} aria-current={active === index ? 'step' : undefined}><span>0{index + 1}</span> {item.name}</button>)}
        </nav>
      </div>
    </div>
  </section>
}
