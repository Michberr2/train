import { lazy, Suspense, useState } from 'react'
import { parseSwarmWorkPlan, type SwarmWorkPlan } from '../../../../../shared/swarmWorkPlan'
import type { SwarmController, SwarmRoomReference } from './swarmTypes'
import './delegated-work.css'

const SwarmStudioPreview = lazy(() => import('./SwarmStudioPreview'))
export interface SavedDelegation { requestId: string; plan: SwarmWorkPlan }
const labels = { queued: 'Queued', running: 'Working', waiting: 'Needs you', done: 'Done', paused: 'Paused', failed: 'Needs attention', cancelled: 'Stopped' }

/** The parent conversation points to live owner-scoped jobs. It never copies
 * private transcripts or invents task completion from the scheduling plan. */
export default function DelegatedWorkCard({ saved, swarm, onOpen, onTrack }: { saved: SavedDelegation; swarm: SwarmController; onOpen: (room: SwarmRoomReference) => void; onTrack: () => void }) {
  const [error, setError] = useState(''), [stopping, setStopping] = useState(false), [stopped, setStopped] = useState(false), [creationId, setCreationId] = useState('')
  // Chat history can arrive from account sync; validate saved metadata before
  // using it as presentation data or passing it back to the scheduler.
  let plan: SwarmWorkPlan
  try {
    if (!saved || typeof saved.requestId !== 'string' || !/^[\w:-]{8,100}$/.test(saved.requestId)) return null
    plan = parseSwarmWorkPlan(saved.plan)
  } catch { return <p role="alert">This saved agent plan could not be loaded. Your existing projects are still in the work drawer.</p> }
  const projects = swarm.state.projects.filter(project => project.delegation?.requestId === saved.requestId)
  const tasks = swarm.state.tasks.filter(task => projects.some(project => project.id === task.projectId))
  const creation = tasks.find(task => task.id === creationId && task.artifact)
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
          {task.artifact && swarm.getArtifact && <button type="button" onClick={() => setCreationId(task.id)}>View creation</button>}
        </div>)}
        {project && <button type="button" onClick={() => onOpen({ projectId: project.id, thread: 'group' })}>Open this project ↗</button>}
      </article>
    })}
    {error && <p role="alert">{error}</p>}
    {swarm.stopDelegation && !stopped && (tasks.length === 0 || tasks.some(task => ['queued', 'running', 'waiting'].includes(task.status))) && <button type="button" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Stopping agents…' : 'Stop these agents'}</button>}
    {creation && <Suspense fallback={<p role="status">Opening creation…</p>}><SwarmStudioPreview key={`${creation.id}:${creation.artifact!.executionId}`} task={creation} swarm={swarm} onClose={() => setCreationId('')}/></Suspense>}
  </section>
}
