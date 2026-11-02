import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { parseSwarmWorkPlan, type SwarmWorkPlan } from '../../../../../shared/swarmWorkPlan'
import type { SwarmController, SwarmRoomReference, SwarmTask } from './swarmTypes'
import './delegated-work.css'

const SwarmStudioPreview = lazy(() => import('./SwarmStudioPreview'))
export interface SavedDelegation { requestId: string; plan: SwarmWorkPlan }
const labels = { queued: 'Queued', running: 'Working', waiting: 'Needs you', done: 'Done', paused: 'Paused', failed: 'Needs attention', cancelled: 'Stopped' }

function CreationInChat({ task, swarm }: { task: SwarmTask; swarm: SwarmController }) {
  const container = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false), [collapsed, setCollapsed] = useState(false)
  const room: SwarmRoomReference = { projectId: task.projectId, thread: 'group' }
  const scoped: SwarmController = { ...swarm,
    getArtifact: swarm.getArtifact ? (id, executionId, signal) => swarm.getArtifact!(id, executionId, signal, room) : undefined,
    loadArtifactMedia: swarm.loadArtifactMedia ? (id, executionId, media, signal) => swarm.loadArtifactMedia!(id, executionId, media, signal, room) : undefined,
    updateArtifact: swarm.updateArtifact ? (id, executionId, revision, payload) => swarm.updateArtifact!(id, executionId, revision, payload, room) : undefined,
  }
  useEffect(() => {
    if (!container.current) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '200px' })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  return <div ref={container} className="nalu-chat-creation" data-creation-execution={task.artifact!.executionId}>
    {collapsed ? <button type="button" onClick={() => setCollapsed(false)}>Show creation</button> : visible ? <Suspense fallback={<p role="status">Opening creation…</p>}><SwarmStudioPreview inline task={task} swarm={scoped} onClose={() => setCollapsed(true)}/></Suspense> : <p role="status">Your {task.artifact!.studioKind} is ready below.</p>}
  </div>
}

/** The parent conversation points to live owner-scoped jobs. It never copies
 * private transcripts or invents task completion from the scheduling plan. */
export default function DelegatedWorkCard({ saved, swarm, onOpen, onTrack }: { saved: SavedDelegation; swarm: SwarmController; onOpen: (room: SwarmRoomReference) => void; onTrack: () => void }) {
  const [error, setError] = useState(''), [stopping, setStopping] = useState(false), [stopped, setStopped] = useState(false)
  // Chat history can arrive from account sync; validate saved metadata before
  // using it as presentation data or passing it back to the scheduler.
  let plan: SwarmWorkPlan
  try {
    if (!saved || typeof saved.requestId !== 'string' || !/^[\w:-]{8,100}$/.test(saved.requestId)) return null
    plan = parseSwarmWorkPlan(saved.plan)
  } catch { return <p role="alert">This saved agent plan could not be loaded. Your existing projects are still in the work drawer.</p> }
  const projects = swarm.state.projects.filter(project => project.delegation?.requestId === saved.requestId)
  const tasks = swarm.state.tasks.filter(task => projects.some(project => project.id === task.projectId) && (task.threads || ['group', task.assignee]).includes('group'))
  const stop = async () => {
    if (!swarm.stopDelegation) return
    setStopping(true); setError('')
    try { await swarm.stopDelegation(saved.requestId); setStopped(true) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Stop has not been confirmed. Nalu will retry when the connection returns.') }
    finally { setStopping(false) }
  }
  return <section className="nalu-delegated-work" aria-label="Delegated agent work">
    <header><strong>Your agents’ work</strong><button type="button" onClick={onTrack}>Track all work ↗</button></header>
    {plan.projects.map(group => {
      const project = projects.find(project => project.delegation?.key === group.key)
      const items = tasks.filter(task => task.projectId === project?.id)
      return <article key={group.key}><h4>{group.title}</h4>
        {!project && <p role="status">{stopped ? 'Stopped before work was confirmed.' : 'Scheduling has not been confirmed yet.'}</p>}
        {items.map(task => <div className="nalu-delegated-task" key={task.id} data-task-status={task.status}>
          <span>{task.assignee} · {labels[task.status]}</span><p>{task.title}</p><small>{task.summary}</small>
          {task.artifact && swarm.getArtifact && <CreationInChat key={`${task.id}:${task.artifact.executionId}`} task={task} swarm={swarm}/>}
        </div>)}
        {project && <button type="button" onClick={() => onOpen({ projectId: project.id, thread: 'group' })}>Open this project ↗</button>}
      </article>
    })}
    {error && <p role="alert">{error}</p>}
    {swarm.stopDelegation && !stopped && (tasks.length === 0 || tasks.some(task => ['queued', 'running', 'waiting'].includes(task.status))) && <button type="button" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping agents…' : 'Stop these agents'}</button>}
  </section>
}
