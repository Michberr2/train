import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { motion, useInView, useMotionValueEvent, useScroll, useSpring, useTransform, type MotionValue } from 'framer-motion'
import { ArrowDown, Braces, Check, FileText, Layers, Terminal } from 'lucide-react'
import Scenery from '../Scenery'
import NaluMark from './NaluMark'

const steps = [
  { name: 'Ingest', description: 'Text, voice, and files become task input. Nalu selects relevant conversations, project data, and saved work from your account to assemble the context.', detail: 'Text + voice + files → account-scoped context', status: 'Input normalized / context assembled' },
  { name: 'Route & plan', description: 'Model and specialist routing match the request to the work. The task orchestrator connects context, instructions, and execution steps.', detail: 'Context selection → model routing → task plan', status: 'Model selected / execution planned' },
  { name: 'Execute', description: 'Tools and agents run the steps: research, code, data processing, and artifact generation. Workflow state tracks the work as it moves between steps.', detail: 'Tool calls → workflow steps → structured artifacts', status: 'Tools executing / artifacts generated' },
  { name: 'Persist & sync', description: 'Outputs, task records, and run history stay with your account. Review the artifacts, resume the workflow, or continue in Nalu on another device.', detail: 'Artifacts + task state → web / desktop / mobile', status: 'Outputs saved / workspace synchronized' },
]

const runtimeNodes = [
  { id: 'request', name: 'Inputs', label: 'input ingestion', tags: 'TEXT / VOICE / FILES', stage: 0, start: .01, end: .07, detail: 'Normalize requests and attachments into task input.' },
  { id: 'context', name: 'Context engine', label: 'context ingestion', tags: 'ACCOUNT / FILES / HISTORY', stage: 0, start: .1, end: .18, detail: 'Select relevant account history, project files, and saved work.', control: true },
  { id: 'core', name: 'Model router', label: 'model routing', tags: 'MODELS / SPECIALISTS', stage: 1, start: .28, end: .35, detail: 'Route the request to a model and specialist with assembled context.' },
  { id: 'plan', name: 'Task orchestrator', label: 'task orchestration', tags: 'PLANS / TOOLS / STATE', stage: 1, start: .38, end: .45, detail: 'Coordinate workflow steps, tool calls, and persisted run state.', control: true },
  { id: 'research', name: 'Tool runtime', label: 'tool execution', tags: 'SEARCH / CODE / APIS', stage: 2, start: .52, end: .59, detail: 'Execute research, code, and connected actions within the task.' },
  { id: 'create', name: 'Artifacts', label: 'artifact generation', tags: 'DOCS / DATA / MEDIA', stage: 2, start: .64, end: .71, detail: 'Compile results into documents, datasets, presentations, and media.' },
  { id: 'result', name: 'Workspace', label: 'persistence and sync', tags: 'SAVED / SYNCED', stage: 3, start: .8, end: .88, detail: 'Persist artifacts and task history for web, desktop, and mobile.' },
]

function RuntimeNode({ node, active, progress, reduced, onSelect, onInspect, children }: {
  node: typeof runtimeNodes[number]; active: number; progress: MotionValue<number>; reduced: boolean;
  onSelect: (stage: number) => void; onInspect: (node: typeof runtimeNodes[number] | null) => void; children?: ReactNode;
}) {
  const reveal = useTransform(progress, [node.start, node.end], [0, 1])
  const border = useTransform(progress, [node.start, node.end], ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.6)'])
  const opacity = useTransform(progress, [node.start, node.end], [.38, 1])
  const clipPath = useTransform(progress, [node.start, node.end], ['inset(0 100% 0 0)', 'inset(0 0% 0 0)'])
  return <motion.button
    className={`${node.control ? 'nalu-plan-node' : 'nalu-process-node'} nalu-node-${node.id} ${active === node.stage ? 'is-active' : ''}`}
    style={reduced ? undefined : { borderColor: border }}
    onClick={() => onSelect(node.stage)} onPointerEnter={() => onInspect(node)} onPointerLeave={() => onInspect(null)}
    onFocus={() => onInspect(node)} onBlur={() => onInspect(null)}
    aria-label={`Explore ${node.label}`} aria-pressed={active === node.stage}
  >
    <motion.span style={reduced ? undefined : { opacity }}>{node.name}</motion.span>
    {children && <motion.span className="nalu-node-symbol" style={reduced ? undefined : { opacity: reveal, clipPath }}>{children}</motion.span>}
    <motion.small style={reduced ? undefined : { opacity }}>{node.tags}</motion.small>
  </motion.button>
}

function SignalPath({ d, start, end, progress, reduced, running, arrow, control = false }: {
  d: string; start: number; end: number; progress: MotionValue<number>; reduced: boolean; running: boolean; arrow: string; control?: boolean;
}) {
  const length = useTransform(progress, [start, end], [0, 1])
  const connected = useTransform(progress, [end, end + .015], [0, 1])
  return <g>
    <path className="nalu-wire-track" d={d} />
    <motion.path className={`nalu-wire-drawn ${control ? 'is-control' : ''}`} d={d} style={{ pathLength: reduced ? 1 : length }} />
    <motion.path className="nalu-wire-arrow" d={d} markerEnd={`url(#${arrow})`} style={{ opacity: reduced ? 1 : connected }} />
    {!reduced && running && <motion.circle r={control ? 2 : 2.7} className="nalu-signal-packet" style={{ opacity: connected }}>
      <animateMotion dur={control ? '3.8s' : '2.6s'} repeatCount="indefinite" path={d} begin={`${-start * 6}s`} />
    </motion.circle>}
  </g>
}

function CoreDiagram({ active, onSelect, progress, reduced }: { active: number; onSelect: (step: number) => void; progress: MotionValue<number>; reduced: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const running = useInView(ref)
  const arrow = `nalu-signal-${useId().replace(/:/g, '')}`
  const [inspected, setInspected] = useState<typeof runtimeNodes[number] | null>(null)
  const controlOpacity = useTransform(progress, [.1, .45], [.1, 1])
  const icons: Record<string, ReactNode> = { request: <Braces />, core: <NaluMark />, research: <Terminal />, create: <Layers />, result: active === 3 ? <Check /> : <FileText /> }
  return <div ref={ref} className="nalu-core-diagram" data-stage={active} aria-label="Nalu architecture: inputs and account context feed model routing, tool execution, artifact generation, and a synchronized workspace.">
    <div className="nalu-diagram-heading"><h3>Nalu execution platform</h3><p><span /> CONTROL PLANE <span /> EXECUTION PLANE</p></div>
    <span className="nalu-diagram-example">{inspected?.name || ['CONTEXT INGESTION', 'MODEL ORCHESTRATION', 'TOOL EXECUTION', 'SYSTEM CONNECTED'][active]}</span>
    <svg className="nalu-core-wires" viewBox="0 0 1000 600" preserveAspectRatio="none" fill="none" aria-hidden="true">
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10Z" fill="currentColor" /></marker></defs>
      <rect className="nalu-work-plane" x="268" y="245" width="540" height="270" />
      <motion.rect className="nalu-control-plane" x="268" y="105" width="500" height="100" style={{ opacity: reduced ? 1 : controlOpacity }} />
      <SignalPath d="M175 390H300" start={.2} end={.28} {...{ progress, reduced, running, arrow }} />
      <SignalPath d="M365 185V320" start={.2} end={.28} control {...{ progress, reduced, running, arrow }} />
      <SignalPath d="M445 152H595" start={.32} end={.38} control {...{ progress, reduced, running, arrow }} />
      <SignalPath d="M675 185V230H555V320" start={.45} end={.52} control {...{ progress, reduced, running, arrow }} />
      <SignalPath d="M430 390H490" start={.45} end={.52} {...{ progress, reduced, running, arrow }} />
      <SignalPath d="M620 390H680" start={.59} end={.64} {...{ progress, reduced, running, arrow }} />
      <SignalPath d="M810 390H850" start={.72} end={.8} {...{ progress, reduced, running, arrow }} />
      <SignalPath d="M915 320V152H755" start={.89} end={.95} control {...{ progress, reduced, running, arrow }} />
    </svg>
    <span className="nalu-plane-label nalu-plane-think">CONTROL PLANE</span>
    {runtimeNodes.map(node => <RuntimeNode key={node.id} node={node} active={active} progress={progress} reduced={reduced} onSelect={onSelect} onInspect={setInspected}>{icons[node.id]}</RuntimeNode>)}
    <span className="nalu-plane-label nalu-plane-do">UNIFIED EXECUTION PLANE</span>
    <div className={`nalu-core-caption ${inspected ? 'is-inspecting' : ''}`}><span>{inspected ? inspected.detail : 'HOVER OR TAP A NODE TO INSPECT'}</span><span>0{active + 1} / 04</span></div>
    <div className="nalu-core-status" aria-hidden="true"><span>{steps[active].status}</span><div>{runtimeNodes.filter(node => !node.control).map(node => <i key={node.id} className={active >= node.stage ? 'is-active' : ''} />)}</div></div>
  </div>
}

export default function NeuralCore({ container, reduced }: { container: RefObject<HTMLDivElement>; reduced: boolean }) {
  const section = useRef<HTMLElement>(null)
  const [active, setActive] = useState(0)
  const [compact, setCompact] = useState(() => window.matchMedia('(max-height: 700px) and (max-width: 900px)').matches)
  const staticMode = reduced || compact
  useEffect(() => {
    const query = window.matchMedia('(max-height: 700px) and (max-width: 900px)')
    const update = () => setCompact(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const { scrollYProgress } = useScroll({ container, target: section, layoutEffect: false, offset: ['start start', 'end end'] })
  const progress = useSpring(scrollYProgress, { stiffness: 100, damping: 30, restDelta: .001 })
  useMotionValueEvent(scrollYProgress, 'change', value => { if (!staticMode) setActive(Math.min(3, Math.max(0, Math.floor(value * 4)))) })
  const selectStep = (index: number) => {
    if (staticMode) { setActive(index); return }
    const host = container.current, target = section.current
    if (!host || !target) return
    const top = target.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
    host.scrollTo({ top: top + (target.offsetHeight - host.clientHeight) * ((index + .85) / 4), behavior: 'smooth' })
  }
  return <section id="platform" ref={section} className="nalu-process" aria-labelledby="nalu-process-title" data-reduced-motion={staticMode}>
    <div className="nalu-process-sticky">
      <div className="nalu-scene"><Scenery src="/images/bg-sandy-beach.png" /></div><div className="nalu-scene-shade" /><div className="nalu-scene-grid" aria-hidden="true" />
      <div className="nalu-process-content">
        <div className="nalu-section-topline"><span>01 / SYSTEM ARCHITECTURE</span><span className="nalu-scroll-direction">{staticMode ? 'CHOOSE A STAGE TO EXPLORE' : 'SCROLL THROUGH THE RUNTIME'} <ArrowDown size={12} /></span></div>
        <h2 id="nalu-process-title">The Nalu Core.</h2>
        <div className="nalu-process-layout">
          <div className="nalu-process-steps">{steps.map((step, index) => <button key={step.name} className={`nalu-step ${active === index ? 'is-active' : ''}`} onClick={() => selectStep(index)} aria-current={active === index ? 'step' : undefined} aria-controls="nalu-step-detail"><span className="nalu-step-number">0{index + 1}</span><span>{step.name}</span>{active === index && <span className="nalu-step-description">{step.description}</span>}</button>)}</div>
          <div className="nalu-process-visual"><CoreDiagram active={active} onSelect={selectStep} progress={progress} reduced={staticMode} /><div id="nalu-step-detail" className="nalu-process-detail"><span>EXECUTION SEQUENCE</span><p>{steps[active].detail}</p><div className="nalu-process-progress" aria-hidden="true">{steps.map((step, index) => <i key={step.name} className={active >= index ? 'is-active' : ''} />)}</div><p className="nalu-process-mobile-description">{steps[active].description}</p></div></div>
        </div>
      </div>
    </div>
  </section>
}
