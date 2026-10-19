import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowUp, Plus, Square, X } from 'lucide-react'
import { AgentHead, type AgentName } from './WorkspaceAgentIdentity'
import { selectSwarmThreadTasks, swarmProjectOverview, type SwarmController } from '../../workspace/design/swarmTypes'
import Markdown from '../../workspace/Markdown'
import './workspace-swarm.css'

const SwarmStudioPreview = lazy(() => import('../../workspace/design/SwarmStudioPreview'))

type Props = {
  swarm: SwarmController
  navigationKey: number
  onOpenChat: (id: string) => void
  availableChatIds: string[]
}
type Task = SwarmController['state']['tasks'][number]
const AGENTS: AgentName[] = ['Nalu', 'Rocky', 'Milo']
const STATUS_LABEL: Record<Task['status'], string> = { queued: 'Queued', running: 'In progress', waiting: 'Needs you', done: 'Ready', paused: 'Paused', failed: 'Needs attention', cancelled: 'Stopped' }
const SAMPLE_STATUSES: Task['status'][] = ['queued', 'running', 'waiting', 'done', 'paused']

function Face({ name }: { name: AgentName }) {
  return <span className="swarm-agent-face" data-agent={name} aria-hidden="true"><AgentHead name={name} className="swarm-agent-head"/></span>
}

function LiveTaskActions({ task, swarm }: { task: Task; swarm: SwarmController }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const blocked = busy || swarm.busyTaskIds?.includes(task.id)
  const canStart = ['queued', 'paused', 'failed', 'cancelled'].includes(task.status) && !(task.status === 'queued' && task.executionId)
  const canStop = task.status === 'running' || task.status === 'waiting' || task.status === 'queued' && !!task.executionId
  const request = async (action: SwarmController['startTask']) => {
    if (!action || blocked || inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try { await action(task.id) }
    catch (error) { setError(error instanceof Error ? error.message : 'That request could not be completed. Please try again.') }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <>
    {canStart && swarm.startTask && <button type="button" disabled={blocked} aria-label={`Start ${task.title}`} onClick={() => void request(swarm.startTask)}>{busy ? 'Requesting…' : task.status === 'failed' || task.status === 'cancelled' ? 'Retry task' : task.status === 'paused' ? 'Resume task' : 'Start task'}</button>}
    {task.status === 'waiting' && task.handoff && task.handoff.studioKind !== 'book' && task.executionId && !task.artifact && swarm.continueStudio && <button type="button" disabled={blocked} onClick={() => void request(swarm.continueStudio)} aria-label={`Continue ${task.title} in Studio`}>{busy ? 'Requesting…' : 'Continue in Studio'}</button>}
    {task.status === 'waiting' && task.handoff?.studioKind === 'book' && <span className="swarm-task-error">Create long-form books in Studio. Background book generation is not available here yet.</span>}
    {canStop && swarm.stopTask && <button type="button" disabled={blocked} aria-label={`Stop ${task.title}`} onClick={() => void request(swarm.stopTask)}>{busy ? 'Requesting…' : 'Stop task'}</button>}
    {swarm.recipient !== 'group' && !(task.threads ?? ['group', task.assignee]).includes('group') && swarm.shareTask && <button type="button" disabled={blocked} aria-label={`Share ${task.title} and its result with the group`} title="Share this task and its result with the group" onClick={() => void request(swarm.shareTask)}>Share with group</button>}
    {error && <span className="swarm-task-error" role="alert">{error}</span>}
  </>
}

function NewSwarm({ swarm }: { swarm: SwarmController }) {
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus({ preventScroll: true }) }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || !brief.trim() || saving) return
    setSaving(true); setSubmitError('')
    try { await swarm.createProject(title.trim(), brief.trim()) }
    catch { setSubmitError('Your workspace could not be created. Please try again.') }
    finally { setSaving(false) }
  }
  return <div className="swarm-create">
    <div className="swarm-create-heading"><div><h2>Make room for an idea.</h2><p>One project, a shared conversation, and a little help from the team.</p></div><button type="button" className="swarm-icon-button" aria-label="Cancel new Swarm" onClick={() => swarm.setCreating(false)}><X size={15}/></button></div>
    <form onSubmit={event => void submit(event)}>
      <label className="swarm-field">Project name<input ref={input} value={title} onChange={event => setTitle(event.target.value)} maxLength={100} placeholder="A launch, a trip, a new idea…" required/></label>
      <label className="swarm-field">What would you like to work on?<textarea value={brief} onChange={event => setBrief(event.target.value)} maxLength={2000} placeholder="Give everyone a little context and a place to start." rows={3} required/></label>
      <fieldset className="swarm-members"><legend>Your team</legend><div>{AGENTS.map(name => <span key={name} className="swarm-member"><Face name={name}/><span>{name}</span></span>)}</div></fieldset>
      {swarm.state.mode === 'sample' && <p className="swarm-brief">Local sample · conversations and project changes stay in this preview.</p>}
      {(swarm.error || submitError) && <p className="swarm-error" role="alert">{swarm.error || submitError}</p>}
      <button type="submit" className="swarm-create-submit" disabled={!title.trim() || !brief.trim() || saving}>{saving ? 'Creating…' : 'Create Swarm'}</button>
    </form>
  </div>
}

/** Group and direct project conversations; the supplied controller owns all data. */
export default function WorkspaceSwarm({ swarm, navigationKey, onOpenChat, availableChatIds }: Props) {
  const root = useRef<HTMLElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const addTaskButton = useRef<HTMLButtonElement>(null)
  const taskInput = useRef<HTMLTextAreaElement>(null)
  const nearBottom = useRef(true)
  const previousThread = useRef('')
  const [creation, setCreation] = useState<{ taskId: string; executionId: string; threadKey: string } | null>(null)
  const [wide, setWide] = useState(false)
  const [section, setSection] = useState<'conversation' | 'board'>('conversation')
  const [addingTask, setAddingTask] = useState(false)
  const [savingTask, setSavingTask] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskAssignee, setTaskAssignee] = useState<AgentName>('Nalu')
  const sample = swarm.state.mode === 'sample'
  const taskLimit = sample ? 180 : 2000
  const overview = swarmProjectOverview(swarm.state)
  const totals = overview.reduce((sum, item) => ({ running: sum.running + item.running, waiting: sum.waiting + item.waiting }), { running: 0, waiting: 0 })
  const project = swarm.state.projects.find(item => item.id === swarm.activeProjectId) || swarm.state.projects[0]
  const creating = swarm.creating || !project
  const previouslyCreating = useRef(creating)
  const focusComposerAfterCreate = useRef(false)
  const visibleTasks = selectSwarmThreadTasks(swarm.state, swarm.activeProjectId, swarm.recipient)
  const messages = swarm.messages
  const threadKey = `${project?.id || ''}:${swarm.recipient}`
  const taskFormState = useRef({ threadKey, taskTitle, taskAssignee }); taskFormState.current = { threadKey, taskTitle, taskAssignee }
  const validChats = new Set(availableChatIds)
  const creationTask = creation?.threadKey === threadKey ? visibleTasks.find(task => task.id === creation.taskId && task.artifact?.executionId === creation.executionId) : undefined
  useEffect(() => { setCreation(null) }, [threadKey])

  useEffect(() => {
    setSection('conversation')
    const frame = requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [navigationKey])

  useEffect(() => { setAddingTask(false); setSavingTask(false); setTaskTitle(''); setTaskAssignee(swarm.recipient === 'group' ? 'Nalu' : swarm.recipient) }, [project?.id, swarm.recipient])

  useEffect(() => {
    if (previouslyCreating.current && !creating) {
      focusComposerAfterCreate.current = true
      setSection('conversation')
    }
    previouslyCreating.current = creating
    // The compact board unmounts the composer; wait until Conversation renders.
    if (!creating && section === 'conversation' && focusComposerAfterCreate.current && composer.current) {
      focusComposerAfterCreate.current = false
      composer.current.focus({ preventScroll: true })
    }
  }, [creating, section])

  useEffect(() => {
    const element = root.current
    if (!element) return
    const update = () => setWide(element.clientWidth >= 860)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const changed = previousThread.current !== threadKey
    previousThread.current = threadKey
    if (!changed && !nearBottom.current) return
    const frame = requestAnimationFrame(() => {
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
      nearBottom.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [threadKey, messages.length, swarm.pending, section, swarm.creating])

  useEffect(() => {
    const input = composer.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 118)}px`
  }, [swarm.draft, section, swarm.creating])

  const openThread = (recipient: 'group' | AgentName) => {
    swarm.selectRecipient(recipient)
    setSection('conversation')
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }))
  }
  const selectProject = (id: string) => {
    swarm.selectProject(id)
    setSection('conversation')
  }
  const send = (event?: FormEvent) => {
    event?.preventDefault()
    if (!swarm.draft.trim() || swarm.pending || swarm.sending) return
    void Promise.resolve(swarm.send(swarm.draft.trim())).catch(() => { /* The controller exposes request errors via swarm.error. */ })
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }))
  }
  const closeTaskForm = () => {
    setAddingTask(false)
    addTaskButton.current?.focus({ preventScroll: true })
  }
  const addTask = async (event: FormEvent) => {
    event.preventDefault()
    if (!taskTitle.trim() || taskTitle.length > taskLimit || savingTask) return
    const submitted = { ...taskFormState.current }
    setSavingTask(true)
    try {
      await swarm.addTask(taskTitle.trim(), taskAssignee)
      const current = taskFormState.current
      if (current.threadKey === submitted.threadKey && current.taskTitle === submitted.taskTitle && current.taskAssignee === submitted.taskAssignee) { setTaskTitle(''); closeTaskForm() }
    } catch { /* The controller exposes the error; retain this form for retry. */ }
    finally { if (taskFormState.current.threadKey === submitted.threadKey) setSavingTask(false) }
  }
  const trackMessage = (content: string, speaker: 'You' | AgentName) => {
    setTaskTitle(content.trim())
    setTaskAssignee(speaker === 'You' ? swarm.recipient === 'group' ? 'Nalu' : swarm.recipient : speaker)
    setAddingTask(true)
    setSection('board')
    requestAnimationFrame(() => taskInput.current?.focus({ preventScroll: true }))
  }

  return <section ref={root} className="workspace-swarm" data-wide={wide} aria-label="Swarm project workspace">
    {swarm.loading && !project ? <p className="swarm-pending" role="status">Loading your Swarm workspaces…</p> : swarm.creating || !project ? <NewSwarm swarm={swarm}/> : <>
      <header className="swarm-header">
        <div className="swarm-heading"><div><small>Swarm</small>{sample && <span className="swarm-sample-label">Local sample</span>}</div><h2 title={project.title}>{project.title}</h2></div>
        <div className="swarm-project-controls">
          <select className="swarm-project-select" aria-label="Swarm project" value={project.id} onChange={event => selectProject(event.target.value)}>{swarm.state.projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
          <button type="button" className="swarm-icon-button" aria-label="New Swarm" title="New Swarm" onClick={() => swarm.setCreating(true)}><Plus size={16}/></button>
        </div>
      </header>
      <details className="swarm-project-overview">
        <summary><strong>All projects</strong><span>{totals.running} in progress · {totals.waiting} need you</span></summary>
        <nav aria-label="All Swarm projects">{overview.map(item => <button type="button" key={item.project.id}
          aria-current={item.project.id === project.id ? 'page' : undefined}
          aria-label={`${item.project.title}: ${item.running} in progress, ${item.waiting} need you${item.failed ? `, ${item.failed} need attention` : ''}. Open group conversation`}
          title={item.project.title} onClick={() => selectProject(item.project.id)}>
          <strong>{item.project.title}</strong><span>{item.running} in progress · {item.waiting} need you{item.failed > 0 ? ` · ${item.failed} need attention` : ''}</span>
        </button>)}</nav>
      </details>
      <div className="swarm-thread-picker" role="group" aria-label="Project conversations">
        <button type="button" aria-pressed={swarm.recipient === 'group'} onClick={() => openThread('group')}>Group</button>
        <div className="swarm-participant-stack" role="group" aria-label="Swarm participants">
          {project.members.map((name, index) => <button key={name} type="button" title={`Talk to ${name}`} style={{ zIndex: project.members.length - index }} aria-label={`Chat with ${name} about ${project.title}`} aria-pressed={swarm.recipient === name} onClick={() => openThread(name)}><Face name={name}/></button>)}
        </div>
        <div className="swarm-participant-copy"><strong>{swarm.recipient === 'group' ? 'Everyone in this chat' : `Talking with ${swarm.recipient}`}</strong><span title={project.title}>{swarm.recipient === 'group' ? `You, ${project.members.join(', ')}` : `Private · ${project.title}`}</span></div>
      </div>
      {!wide && <div className="swarm-sections" role="group" aria-label="Swarm view"><button type="button" aria-pressed={section === 'conversation'} onClick={() => setSection('conversation')}>Conversation</button><button type="button" aria-pressed={section === 'board'} onClick={() => setSection('board')}>Work in this chat{visibleTasks.some(task => task.status === 'waiting') ? ' · Needs you' : ''}</button></div>}
      {swarm.error && <p className="swarm-error" role="alert">{swarm.error}</p>}
      <div className="swarm-layout">
        {(wide || section === 'conversation') && <div className="swarm-conversation">
          {swarm.recipient !== 'group' && <div className="swarm-direct-context"><button type="button" onClick={() => openThread('group')}><ArrowLeft size={13}/>Back to group</button><span>Private branch · Shared group context</span></div>}
          <div ref={scroll} className="swarm-messages" role="log" aria-label={swarm.recipient === 'group' ? `${project.title} group conversation` : `${swarm.recipient} direct conversation`} aria-live="polite" aria-relevant="additions text" onScroll={() => { const element = scroll.current; if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 70 }}>
            {messages.length === 0 && <div className="swarm-empty-thread"><strong>{swarm.recipient === 'group' ? 'A place to work things out.' : `A moment with ${swarm.recipient}.`}</strong><p>{swarm.recipient === 'group' ? project.brief : `Ask about ${project.title}, share a detail, or work through the next step together.`}</p></div>}
            {messages.map(message => <article key={message.id} className="swarm-message" data-speaker={message.speaker} aria-label={`${message.speaker} message`}>
              {message.speaker !== 'You' && <button type="button" className="swarm-message-agent" aria-label={`Open ${message.speaker} direct conversation`} onClick={() => openThread(message.speaker as AgentName)}><Face name={message.speaker}/></button>}
              <div className="swarm-message-copy"><div className="swarm-message-meta"><strong>{message.speaker}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>{!sample && message.speaker !== 'You' ? <div className="swarm-message-markdown"><Markdown>{message.content}</Markdown></div> : <p>{message.content}</p>}<button type="button" className="swarm-track-message" aria-label={message.speaker === 'You' ? 'Track work from your message' : `Track work from ${message.speaker}'s message`} onClick={() => trackMessage(message.content, message.speaker)}>Track work</button></div>
            </article>)}
            {swarm.sending && !swarm.pending && <p className="swarm-pending" role="status">Sending your message…</p>}
            {swarm.pending && <p className="swarm-pending" role="status">{sample ? swarm.recipient === 'group' ? 'A sample team reply is on its way…' : `${swarm.recipient} is replying in this sample…` : swarm.recipient === 'group' ? 'Your team is replying…' : `${swarm.recipient} is replying…`}</p>}
          </div>
          <div className="swarm-compose-dock"><form className="swarm-composer" onSubmit={send}>
            <textarea ref={composer} rows={1} maxLength={4000} aria-label={swarm.recipient === 'group' ? 'Message the Swarm group' : `Message ${swarm.recipient}`} placeholder={swarm.recipient === 'group' ? 'Message the group…' : `Message ${swarm.recipient}…`} value={swarm.draft} onChange={event => swarm.setDraft(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
            }}/>
            {swarm.pending ? <button type="button" className="swarm-send" aria-label={sample ? 'Stop sample reply' : 'Stop reply'} onClick={swarm.stop}><Square size={12}/></button> : <button type="submit" className="swarm-send" aria-label="Send Swarm message" disabled={!swarm.draft.trim() || swarm.sending}><ArrowUp size={16} strokeWidth={2.4}/></button>}
          </form></div>
        </div>}
        {(wide || section === 'board') && <aside className="swarm-board" aria-label="Work in this chat">
          <section className="swarm-chat-work">
            <div className="swarm-board-heading"><h3>Work in this chat</h3><button ref={addTaskButton} type="button" className="swarm-task-add" onClick={() => setAddingTask(value => !value)} aria-expanded={addingTask}>Add task</button></div>
            <p className="swarm-board-context"><strong>{project.title}</strong><span>{swarm.recipient === 'group' ? 'Tracked in the group' : `Tracked with ${swarm.recipient}`}</span></p>
            <dl className="swarm-work-counts" aria-label="Chat task status totals">
              <div data-status="running"><dt>In progress</dt><dd>{visibleTasks.filter(task => task.status === 'running').length}</dd></div>
              <div data-status="waiting"><dt>Needs you</dt><dd>{visibleTasks.filter(task => task.status === 'waiting').length}</dd></div>
              <div data-status="done"><dt>Ready</dt><dd>{visibleTasks.filter(task => task.status === 'done').length}</dd></div>
            </dl>
            {addingTask && <form className="swarm-add-task-form" onSubmit={event => void addTask(event)}>
              <textarea ref={taskInput} autoFocus value={taskTitle} onChange={event => setTaskTitle(event.target.value)} aria-label="Task instructions" placeholder="Describe what you want the agent to do" rows={3} required/>
              <p className="swarm-task-length" role={taskTitle.length > taskLimit ? 'alert' : undefined}>{taskTitle.length.toLocaleString()} / {taskLimit.toLocaleString()} characters{taskTitle.length > taskLimit ? ' · Shorten the instructions before adding this task.' : ''}</p>
              <div><select aria-label="Assign new task" value={taskAssignee} onChange={event => setTaskAssignee(event.target.value as AgentName)}>{project.members.map(name => <option key={name} value={name}>{name}</option>)}</select><button type="submit" disabled={!taskTitle.trim() || taskTitle.length > taskLimit || savingTask}>{savingTask ? 'Adding…' : 'Add'}</button><button type="button" aria-label="Cancel new task" onClick={closeTaskForm}><X size={13}/></button></div>
            </form>}
            <div className="swarm-tasks">
            {visibleTasks.map(task => <article key={task.id} className="swarm-task" data-status={task.status} aria-label={`${task.title}, ${task.assignee}, ${STATUS_LABEL[task.status]}`}>
              <h4 title={task.title}>{task.title}</h4>
              <div className="swarm-task-controls">
                <div className="swarm-task-owner"><Face name={task.assignee}/><select disabled={!sample && (task.status === 'running' || task.status === 'waiting' || !!task.executionId && task.status === 'queued' || swarm.busyTaskIds?.includes(task.id))} aria-label={`Assignee for ${task.title}`} value={task.assignee} onChange={event => swarm.assignTask(task.id, event.target.value as AgentName)}>{project.members.map(name => <option key={name} value={name}>{name}</option>)}</select></div>
                {sample ? <select className="swarm-task-status" aria-label={`Status for ${task.title}`} value={task.status} onChange={event => swarm.updateTask(task.id, event.target.value as Task['status'])}>{SAMPLE_STATUSES.map(status => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}</select>
                  : <span className="swarm-task-status" role="status" aria-label={`Status for ${task.title}: ${STATUS_LABEL[task.status]}`}>{STATUS_LABEL[task.status]}</span>}
              </div>
              {!sample && typeof task.progress === 'number' && Number.isFinite(task.progress) && <div className="swarm-task-progress"><progress max={1} value={Math.max(0, Math.min(1, task.progress))} aria-label={`Progress for ${task.title}`}/><span>{Math.round(Math.max(0, Math.min(1, task.progress)) * 100)}%</span></div>}
              <div className="swarm-task-actions">{!sample && <LiveTaskActions task={task} swarm={swarm}/>}<button type="button" onClick={() => openThread(task.assignee)} aria-label={`Discuss ${task.title} with ${task.assignee}`}>Message {task.assignee}</button>
                {!sample && task.artifact && swarm.getArtifact && <button type="button" onClick={() => setCreation({ taskId: task.id, executionId: task.artifact!.executionId, threadKey })}>View creation</button>}
                {task.chatId && validChats.has(task.chatId) && <button type="button" onClick={() => onOpenChat(task.chatId!)}>Open saved work</button>}
              </div>
              <details className="swarm-task-details"><summary><span>Details</span><time dateTime={new Date(task.updatedAt).toISOString()} title={new Date(task.updatedAt).toLocaleString()}>Updated {new Date(task.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></summary>{!sample && task.title.length > 140 && <p><strong>Instructions</strong><br/>{task.title}</p>}<p>{task.summary}</p></details>
            </article>)}
            {visibleTasks.length === 0 && <div className="swarm-work-empty"><strong>No work in this chat yet</strong><p>Choose “Track work” on a message, or add a task to this conversation.</p></div>}
          </div></section>
          <details className="swarm-board-context-details" key={project.id}><summary>Shared project brief</summary><p className="swarm-brief">{project.brief}</p></details>
        </aside>}
      </div>
    </>}
    {creationTask && <Suspense fallback={<p role="status">Opening creation…</p>}><SwarmStudioPreview key={`${creationTask.id}:${creationTask.artifact!.executionId}:${threadKey}`} task={creationTask} swarm={swarm} onClose={() => setCreation(null)}/></Suspense>}
  </section>
}
