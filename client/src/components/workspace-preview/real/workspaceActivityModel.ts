// Sample scenarios stay isolated from the production activity adapters.
import type { ActivityChat, ActivityItem, ActivityStatus } from '../../workspace/design/workspaceActivity'
export type { ActivityChat, ActivityItem, ActivityMessage, ActivityStatus } from '../../workspace/design/workspaceActivity'
export { chatActivity, remoteActivity, mergeWorkspaceActivity } from '../../workspace/design/workspaceActivity'

export const DEMO_DURATION_MS = 24_000
export interface ActivityDemoState { elapsed: number; startedAt: number | null; scenarioAt: number }
export const createActivityDemo = (now: number): ActivityDemoState => ({ elapsed: 0, startedAt: null, scenarioAt: now })
export const demoElapsed = (state: ActivityDemoState, now: number) => Math.min(DEMO_DURATION_MS, Math.max(0, state.elapsed + (state.startedAt === null ? 0 : Math.max(0, now - state.startedAt))))
export const demoPlaying = (state: ActivityDemoState, now: number) => state.startedAt !== null && demoElapsed(state, now) < DEMO_DURATION_MS
export function setActivityDemoPlaying(state: ActivityDemoState, playing: boolean, now: number): ActivityDemoState {
  const elapsed = demoElapsed(state, now)
  if (!playing) return { ...state, elapsed, startedAt: null }
  if (demoPlaying(state, now)) return state
  // Replay is an explicit user action. No waiting task is ever approved here.
  return { elapsed: elapsed >= DEMO_DURATION_MS ? 0 : elapsed, startedAt: now, scenarioAt: now - (elapsed >= DEMO_DURATION_MS ? 0 : elapsed) }
}

type DemoStage = { at: number; status: ActivityStatus; detail: string; progress?: number }
const DEMO_TASKS: { chatId: string; stages: DemoStage[]; question?: string }[] = [
  { chatId: 'preview-website', stages: [
    { at: 0, status: 'running', detail: 'Refining the launch page layout.', progress: .32 },
    { at: 8000, status: 'running', detail: 'Reviewing the mobile layout and navigation.', progress: .68 },
    { at: 16000, status: 'running', detail: 'Preparing the website review.', progress: .9 },
    { at: 24000, status: 'done', detail: 'Website review ready. Open the saved page in its conversation.', progress: 1 },
  ] },
  { chatId: 'preview-budget', stages: [
    { at: 0, status: 'running', detail: 'Checking the launch budget totals.', progress: .4 },
    { at: 6000, status: 'running', detail: 'Comparing planned spend with actual costs.', progress: .72 },
    { at: 15000, status: 'done', detail: 'Budget analysis ready. Review the saved spreadsheet.', progress: 1 },
  ] },
  { chatId: 'preview-brief', stages: [{ at: 0, status: 'waiting', detail: 'The launch brief is ready for your review.' }], question: 'What would you change before sharing the launch brief?' },
  { chatId: 'preview-story', stages: [{ at: 0, status: 'done', detail: 'The launch presentation is ready to review.', progress: 1 }] },
]

export function sampleActivity(chats: ActivityChat[], state: ActivityDemoState, now: number): ActivityItem[] {
  const elapsed = demoElapsed(state, now)
  const byId = new Map(chats.map(chat => [chat.id, chat]))
  return DEMO_TASKS.flatMap(({ chatId, stages, question }): ActivityItem[] => {
    const chat = byId.get(chatId)
    if (!chat) return []
    const reached = stages.filter(stage => stage.at <= elapsed)
    const stage = reached[reached.length - 1]
    const at = state.scenarioAt + stage.at
    return [{
      id: `sample-work:${chatId}`, chatId, title: chat.title, status: stage.status, detail: stage.detail,
      ...(stage.progress !== undefined ? { progress: stage.progress } : {}),
      events: reached.map(item => ({ t: new Date(state.scenarioAt + item.at).toISOString(), m: item.detail })),
      createdAt: state.scenarioAt - 120_000, updatedAt: at, source: 'studio', preview: true,
      ...(question ? { pendingQuestion: { id: 'sample-brief-review', text: question } } : {}),
    }]
  })
}
