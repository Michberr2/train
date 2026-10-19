import { useEffect, useState } from 'react'
import { Braces, Database, FileText, Layers, MapPin, Search, SlidersHorizontal, Terminal, type LucideIcon } from 'lucide-react'
import NaluMark from '../../landing/NaluMark'
import type { WorkspaceCarouselView } from './WorkspaceCarousel'
import './workspace-core-visual.css'

type Node = { label: string; detail: string; icon?: LucideIcon; mark?: boolean }
type Graph = { title: string; control: string; policy: string; nodes: Node[]; feedback?: boolean }

const GRAPHS: Record<WorkspaceCarouselView, Graph> = {
  chat: {
    title: 'CONVERSATION ENGINE', control: 'Context selection', policy: 'ACCOUNT / HISTORY', feedback: true,
    nodes: [
      { label: 'Input', detail: 'TEXT / FILES', icon: Braces },
      { label: 'Context', detail: 'RELEVANT WORK', icon: Database },
      { label: 'Router', detail: 'MODELS / TOOLS', mark: true },
      { label: 'Response', detail: 'TEXT / ARTIFACTS', icon: FileText },
    ],
  },
  studio: {
    title: 'CREATION ENGINE', control: 'Creative direction', policy: 'BRIEF / BRAND / STYLE',
    nodes: [
      { label: 'Brief', detail: 'IDEA / REFERENCES', icon: Braces },
      { label: 'Tool', detail: 'GENERATION', mark: true },
      { label: 'Artifact', detail: 'DOCS / DATA / MEDIA', icon: Layers },
      { label: 'Output', detail: 'PREVIEW / EXPORT', icon: FileText },
    ],
  },
  map: {
    title: 'SPATIAL WORKSPACE', control: 'Spatial context', policy: 'LOCATION / EXTENT',
    nodes: [
      { label: 'Query', detail: 'PLACE / QUESTION', mark: true },
      { label: 'Geodata', detail: 'PUBLIC SOURCES', icon: Database },
      { label: 'Layers', detail: 'OVERLAYS / SHAPES', icon: Layers },
      { label: 'View', detail: 'MAP / CAMERA', icon: MapPin },
    ],
  },
  agents: {
    title: 'WORKFLOW ENGINE', control: 'Task orchestrator', policy: 'SCHEDULE / STATE', feedback: true,
    nodes: [
      { label: 'Trigger', detail: 'MANUAL / SCHEDULE', icon: Braces },
      { label: 'Plan', detail: 'STEPS / ROUTING', mark: true },
      { label: 'Tools', detail: 'AGENTS / ACTIONS', icon: Terminal },
      { label: 'Run log', detail: 'HISTORY / OUTPUTS', icon: FileText },
    ],
  },
  memory: {
    title: 'ACCOUNT CONTEXT', control: 'Account scope', policy: 'YOUR SAVED WORK', feedback: true,
    nodes: [
      { label: 'History', detail: 'CHATS / ARTIFACTS', icon: Database },
      { label: 'Context', detail: 'RELEVANT MATERIAL', mark: true },
      { label: 'Retrieval', detail: 'SEARCH / RECALL', icon: Search },
    ],
  },
  skills: {
    title: 'CAPABILITY LAYER', control: 'Skill configuration', policy: 'GUIDANCE / PREFERENCES',
    nodes: [
      { label: 'Instructions', detail: 'BEHAVIOR / SCOPE', icon: SlidersHorizontal },
      { label: 'Tools', detail: 'CAPABILITIES', icon: Terminal },
      { label: 'Execution', detail: 'TASK CONTEXT', mark: true },
    ],
  },
}

/** A decorative architecture miniature, matching the landing page's Nalu Core.
 * Packets illustrate connections; they do not represent live account activity. */
export default function WorkspaceCoreVisual({ view, active }: { view: WorkspaceCarouselView; active: boolean }) {
  const [reduced, setReduced] = useState(() => typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const graph = GRAPHS[view]
  const compact = graph.nodes.length === 3
  const width = compact ? 66 : 58
  const positions = compact ? [12, 117, 222] : [7, 83, 159, 235]
  const paths = positions.slice(0, -1).map((x, index) => `M${x + width} 116H${positions[index + 1]}`)
  const controlTargets = compact ? [positions[1] + width / 2] : [positions[1] + width / 2, positions[2] + width / 2]
  const controlPaths = controlTargets.map((x, index) => `M${index ? 166 : 134} 60V73H${x}V88`)
  if (graph.feedback) controlPaths.push(`M${positions[positions.length - 1] + width / 2} 88V42H192`)
  return <div className="workspace-core-visual" data-core-active={active} data-core-space={view} aria-hidden="true">
    <span className="workspace-core-visual-title">{graph.title}</span>
    <span className="workspace-core-control-label">CONTROL PLANE</span>
    <svg className="workspace-core-wire-layer" viewBox="0 0 300 174" fill="none" preserveAspectRatio="none" aria-hidden="true">
      <rect x="77" y="18" width="146" height="53" className="workspace-core-plane"/>
      <rect x="2" y="80" width="296" height="78" className="workspace-core-plane"/>
      {controlPaths.map((path, index) => <g key={`control-${index}`}>
        <path d={path} className="workspace-core-control-wire"/>
        {active && !reduced && <circle r="1.25" className="workspace-core-packet"><animateMotion path={path} dur="5.4s" begin={`${index * -1.4}s`} repeatCount="indefinite"/></circle>}
      </g>)}
      {paths.map((path, index) => <g key={`work-${index}`}>
        <path d={path} className="workspace-core-wire"/>
        <path d={`M${positions[index + 1] - 4} 113l4 3-4 3`} className="workspace-core-arrow"/>
        {active && !reduced && <circle r="1.6" className="workspace-core-packet"><animateMotion path={path} dur="3.8s" begin={`${index * -.9}s`} repeatCount="indefinite"/></circle>}
      </g>)}
    </svg>
    <div className="workspace-core-control-node"><strong>{graph.control}</strong><small>{graph.policy}</small></div>
    {graph.nodes.map((node, index) => {
      const Icon = node.icon
      return <div key={node.label} className={`workspace-core-mini-node${node.mark ? ' workspace-core-mini-router' : ''}`} style={{ left: `${positions[index] / 3}%`, width: `${width / 3}%` }}>
        <strong>{node.label}</strong><span>{node.mark ? <NaluMark/> : Icon ? <Icon strokeWidth={1}/> : null}</span><small>{node.detail}</small>
      </div>
    })}
    <span className="workspace-core-execution-label">UNIFIED EXECUTION PLANE</span>
  </div>
}
