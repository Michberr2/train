import { isSwarmRoom, type SwarmState } from './swarmTypes'
import type { ActivityItem, ActivityStatus, WorkspaceActivityController } from './workspaceActivity'

/** Owner-visible overview only. No transcript text, fabricated chat links,
 * synthetic progress, or changes to a task's explicit conversation links. */
export function swarmActivity(state: SwarmState): ActivityItem[] {
  if (state.mode !== 'live') return []
  const projects = new Map(state.projects.map(project => [project.id, project]))
  const tasks = state.tasks.flatMap((task): ActivityItem[] => {
    const project = projects.get(task.projectId), thread = task.threads?.[0]
    if (!project || !project.members.includes(task.assignee) || !isSwarmRoom(state, task.projectId, thread)) return []
    return [{ id: `swarm:task:${task.id}`, title: `${project.title} · ${task.title}`, detail: task.summary,
      status: task.status, createdAt: project.createdAt, updatedAt: task.updatedAt,
      ...(typeof task.progress === 'number' && Number.isFinite(task.progress) ? { progress: task.progress } : {}),
      source: 'Swarm', preview: false, events: [],
      swarm: { projectId: task.projectId, projectTitle: project.title, thread, agent: task.assignee, taskId: task.id } }]
  })
  const replies = state.turns.flatMap((turn): ActivityItem[] => {
    const project = projects.get(turn.projectId)
    if (!project || !project.members.includes(turn.replySpeaker) || !isSwarmRoom(state, turn.projectId, turn.thread) || !['pending', 'failed'].includes(turn.status)) return []
    return [{ id: `swarm:turn:${turn.id}`, title: `${project.title} · ${turn.thread === 'group' ? 'Group conversation' : `${turn.thread} private chat`}`,
      detail: turn.status === 'pending' ? `${turn.replySpeaker} is replying.` : `${turn.replySpeaker} could not finish this reply. Open the conversation for details.`,
      status: turn.status === 'pending' ? 'running' : 'failed', createdAt: turn.createdAt, updatedAt: turn.updatedAt,
      source: 'Swarm', preview: false, events: [],
      swarm: { projectId: turn.projectId, projectTitle: project.title, thread: turn.thread, agent: turn.replySpeaker } }]
  })
  return [...tasks, ...replies]
}

export function withSwarmActivity(activity: WorkspaceActivityController, state: SwarmState): WorkspaceActivityController {
  const priority: Record<ActivityStatus, number> = { waiting: 0, failed: 1, running: 2, queued: 3, paused: 4, done: 5, cancelled: 6, saved: 7 }
  return { ...activity, items: [...activity.items, ...swarmActivity(state)].sort((a, b) => priority[a.status] - priority[b.status] || b.updatedAt - a.updatedAt) }
}
