import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react'
import './workspace-carousel.css'
import WorkspaceCoreVisual from './WorkspaceCoreVisual'
import WorkspaceMapVisual from './WorkspaceMapVisual'
import WorkspaceExperienceVisual from './WorkspaceExperienceVisual'

export type WorkspaceCarouselView = 'chat' | 'studio' | 'map' | 'agents' | 'memory' | 'skills'

const SPACES: { view: WorkspaceCarouselView; name: string; title: string; description: string; action: string }[] = [
  { view: 'chat', name: 'Chat', title: 'Talk it through.', description: 'Research a question, shape an idea, or work out your next move.', action: 'Open Chat' },
  { view: 'studio', name: 'Studio', title: 'Create something.', description: 'Make websites, decks, documents, images, and spreadsheets. Edit and export your work.', action: 'Open Studio' },
  { view: 'agents', name: 'Autopilot', title: 'Put work on autopilot.', description: 'Start with a template. Connect the steps. Run a repeatable workflow.', action: 'Open Autopilot' },
  { view: 'map', name: 'Map', title: 'Explore a place.', description: 'Search places, compare areas, and see the world in 2D or 3D.', action: 'Explore the map' },
  { view: 'memory', name: 'Memory', title: 'Your work, in motion.', description: 'See what’s working, what needs you, and jump back into any conversation.', action: 'Open Memory' },
  { view: 'skills', name: 'Skills', title: 'Make Nalu yours.', description: 'Choose the tools Nalu can use for research, creation, and everyday work.', action: 'Choose your skills' },
]

export default function WorkspaceCarousel({ onOpen, onClose, initialView = 'studio' }: {
  onOpen: (view: WorkspaceCarouselView) => void
  onClose?: () => void
  initialView?: WorkspaceCarouselView
}) {
  const [selected, setSelected] = useState(() => Math.max(0, SPACES.findIndex(space => space.view === initialView)))
  const root = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const move = (direction: number) => setSelected(index => (index + direction + SPACES.length) % SPACES.length)
  useEffect(() => { root.current?.focus({ preventScroll: true }) }, [])
  return <div ref={root} id="workspace-space-picker" className="workspace-carousel-root" tabIndex={-1} role="region" aria-roledescription="carousel" aria-label="Choose a workspace"
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); onClose?.(); return }
      if (event.key === 'Enter' && event.target === root.current) { event.preventDefault(); event.stopPropagation(); onOpen(SPACES[selected].view); return }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        // The selected card's Open button unmounts when selection changes.
        // Keep keyboard focus inside the carousel so repeated arrows work.
        root.current?.focus({ preventScroll: true })
        if (event.key === 'Home') setSelected(0)
        else if (event.key === 'End') setSelected(SPACES.length - 1)
        else move(event.key === 'ArrowLeft' ? -1 : 1)
      }
    }}>
    <div className="workspace-carousel-heading"><span>YOUR NALU</span><h1>What would you like to do?</h1><p>From your first thought to your finished work.</p></div>
    <div className="workspace-carousel-stage" onPointerDown={event => { pointer.current = { x: event.clientX, y: event.clientY } }}
      onPointerCancel={() => { pointer.current = null }}
      onPointerUp={event => {
        const start = pointer.current; pointer.current = null
        if (!start) return
        const dx = event.clientX - start.x, dy = event.clientY - start.y
        if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          suppressClick.current = true; move(dx > 0 ? -1 : 1)
          window.setTimeout(() => { suppressClick.current = false }, 250)
        }
      }}>
      <div className="workspace-carousel-orbit" aria-hidden="true"/>
      <div className="workspace-carousel-ring">
        {SPACES.map((space, index) => {
          let distance = (index - selected + SPACES.length) % SPACES.length
          if (distance > SPACES.length / 2) distance -= SPACES.length
          const active = distance === 0, visible = Math.abs(distance) <= 1
          const angle = distance * Math.PI / 3
          const style = { '--carousel-x': Math.sin(angle), '--carousel-z': Math.cos(angle) - 1, '--carousel-tilt': `${distance * -24}deg`, '--carousel-opacity': active ? 1 : Math.abs(distance) === 1 ? .89 : .3, zIndex: 10 - Math.abs(distance) } as CSSProperties
          return <article key={space.view} ref={element => { if (element) element.inert = !visible }} style={style}
            className="workspace-carousel-card" data-space={space.view} data-active={active} data-visible={visible} aria-hidden={!visible}>
            <button type="button" className="workspace-carousel-select" tabIndex={-1}
              aria-label={active ? `${space.name}, selected` : `Choose ${space.name}: ${space.title.replace(/\.$/, '')}`}
              onClick={() => { if (!suppressClick.current) { if (active) onOpen(space.view); else setSelected(index) } }}>
              <span className="workspace-carousel-card-label"><i/>{space.name}<span>{String(index + 1).padStart(2, '0')}</span></span>
              {space.view === 'map' ? <WorkspaceMapVisual active={active}/>
                : space.view === 'agents' ? <WorkspaceCoreVisual view="agents" active={active}/>
                : <WorkspaceExperienceVisual view={space.view} active={active}/>}
              <h2>{space.title}</h2><p>{space.description}</p>
            </button>
            {active && <button type="button" className="workspace-carousel-open" onClick={() => { if (!suppressClick.current) onOpen(space.view) }}>
              {space.action}<ArrowRight size={17}/>
            </button>}
            {!active && <span className="workspace-carousel-side-hint" aria-hidden="true">Take a closer look <ArrowRight size={15}/></span>}
          </article>
        })}
      </div>
    </div>
    <div className="workspace-carousel-controls">
      <button type="button" aria-label="Previous workspace" onClick={() => move(-1)}><ChevronLeft size={20}/></button>
      <div className="workspace-carousel-dots" aria-label="Workspace selection">{SPACES.map((space, index) => <button key={space.view} type="button" aria-label={`Show ${space.name}`} aria-pressed={selected === index} onClick={() => setSelected(index)}><span/>{space.name}</button>)}</div>
      <button type="button" aria-label="Next workspace" onClick={() => move(1)}><ChevronRight size={20}/></button>
    </div>
    <p className="workspace-carousel-key-hint"><ArrowLeft size={11}/><ArrowRight size={11}/> Browse your spaces <span>·</span> Swipe or use the arrows</p>
    <span className="workspace-carousel-announcement" aria-live="polite" aria-atomic="true">{SPACES[selected].name}. {selected + 1} of {SPACES.length}.</span>
  </div>
}
