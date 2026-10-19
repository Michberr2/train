import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowUp, Plus, Square, X } from 'lucide-react'
import { AgentHead, type AgentName } from './WorkspaceAgentIdentity'
import type { SwarmController } from './useSwarmPreview'
import { selectSwarmThreadTasks } from './swarmPreviewModel'
import './workspace-swarm.css'

type Props = {
  swarm: SwarmController
  navigationKey: number
  onOpenChat: (id: string) => void
  availableChatIds: string[]
}
type Task = SwarmController['state']['tasks'][number]
const AGENTS: AgentName[] = ['Nalu', 'Rocky', 'Milo']
const STATUS_LABEL: Record<Task['status'], string> = { queued: 'Queued', running: 'In progress', waiting: 'Needs you', done: 'Ready', paused: 'Paused' }

function Face({ name }: { name: AgentName }) {
  return <span className="swarm-agent-face" data-agent={name} aria-hidden="true"><AgentHead name={name} className="swarm-agent-head"/></span>
}

function NewSwarm({ swarm }: { swarm: SwarmController }) {
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus({ preventScroll: true }) }, [])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || !brief.trim()) return
    swarm.createProject(title.trim(), brief.trim())
  }
  return <div className="swarm-create">
    <div className="swarm-create-heading"><div><h2>Make room for an idea.</h2><p>One project, a shared conversation, and a little help from the team.</p></div><button type="button" className="swarm-icon-button" aria-label="Cancel new Swarm" onClick={() => swarm.setCreating(false)}><X size={15}/></button></div>
    <form onSubmit={submit}>
      <label className="swarm-field">Project name<input ref={input} value={title} onChange={event => setTitle(event.target.value)} maxLength={100} placeholder="A launch, a trip, a new idea…" required/></label>
      <label className="swarm-field">What would you like to work on?<textarea value={brief} onChange={event => setBrief(event.target.value)} maxLength={2000} placeholder="Give everyone a little context and a place to start." rows={3} required/></label>
      <fieldset className="swarm-members"><legend>Your team</legend><div>{AGENTS.map(name => <span key={name} className="swarm-member"><Face name={name}/><span>{name}</span></span>)}</div></fieldset>
      <p className="swarm-brief">Local sample · conversations and project changes stay in this preview.</p>
      {swarm.error && <p className="swarm-error" role="alert">{swarm.error}</p>}
      <button type="submit" className="swarm-create-submit" disabled={!title.trim() || !brief.trim()}>Create Swarm</button>
    </form>
  </div>
}

/** Group and direct project conversations, driven by the shared local controller. */
export default function WorkspaceSwarm({ swarm, navigationKey, onOpenChat, availableChatIds }: Props) {
  const root = useRef<HTMLElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const addTaskButton = useRef<HTMLButtonElement>(null)
  const taskInput = useRef<HTMLInputElement>(null)
  const nearBottom = useRef(true)
  const previousThread = useRef('')
  const [wide, setWide] = useState(false)
  const [section, setSection] = useState<'conversation' | 'board'>('conversation')
  const [addingTask, setAddingTask] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskAssignee, setTaskAssignee] = useState<AgentName>('Nalu')
  const project = swarm.state.projects.find(item => item.id === swarm.activeProjectId) || swarm.state.projects[0]
  const creating = swarm.creating || !project
  const previouslyCreating = useRef(creating)
  const focusComposerAfterCreate = useRef(false)
  const visibleTasks = selectSwarmThreadTasks(swarm.state, swarm.activeProjectId, swarm.recipient)
  const messages = swarm.messages
  const threadKey = `${project?.id || ''}:${swarm.recipient}`
  const validChats = new Set(availableChatIds)

  useEffect(() => {
    setSection('conversation')
    const frame = requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [navigationKey])

  useEffect(() => { setAddingTask(false); setTaskTitle(''); setTaskAssignee(swarm.recipient === 'group' ? 'Nalu' : swarm.recipient) }, [project?.id, swarm.recipient])

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
    if (!swarm.draft.trim() || swarm.pending) return
    swarm.send(swarm.draft.trim())
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }))
  }
  const closeTaskForm = () => {
    setAddingTask(false)
    addTaskButton.current?.focus({ preventScroll: true })
  }
  const trackMessage = (content: string, speaker: 'You' | AgentName) => {
    setTaskTitle(content.replace(/\s+/g, ' ').trim().slice(0, 180))
    setTaskAssignee(speaker === 'You' ? swarm.recipient === 'group' ? 'Nalu' : swarm.recipient : speaker)
    setAddingTask(true)
    setSection('board')
    requestAnimationFrame(() => taskInput.current?.focus({ preventScroll: true }))
  }

  return <section ref={root} className="workspace-swarm" data-wide={wide} aria-label="Swarm project workspace">
    {swarm.creating || !project ? <NewSwarm swarm={swarm}/> : <>
      <header className="swarm-header">
        <div className="swarm-heading"><div><small>Swarm</small><span className="swarm-sample-label">Local sample</span></div><h2 title={project.title}>{project.title}</h2></div>
        <div className="swarm-project-controls">
          <select className="swarm-project-select" aria-label="Swarm project" value={project.id} onChange={event => selectProject(event.target.value)}>{swarm.state.projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
          <button type="button" className="swarm-icon-button" aria-label="New Swarm" title="New Swarm" onClick={() => swarm.setCreating(true)}><Plus size={16}/></button>
        </div>
      </header>
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
              <div className="swarm-message-copy"><div className="swarm-message-meta"><strong>{message.speaker}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><p>{message.content}</p><button type="button" className="swarm-track-message" aria-label={message.speaker === 'You' ? 'Track work from your message' : `Track work from ${message.speaker}'s message`} onClick={() => trackMessage(message.content, message.speaker)}>Track work</button></div>
            </article>)}
            {swarm.pending && <p className="swarm-pending" role="status">{swarm.recipient === 'group' ? 'A sample team reply is on its way…' : `${swarm.recipient} is replying in this sample…`}</p>}
          </div>
          <div className="swarm-compose-dock"><form className="swarm-composer" onSubmit={send}>
            <textarea ref={composer} rows={1} maxLength={4000} aria-label={swarm.recipient === 'group' ? 'Message the Swarm group' : `Message ${swarm.recipient}`} placeholder={swarm.recipient === 'group' ? 'Message the group…' : `Message ${swarm.recipient}…`} value={swarm.draft} onChange={event => swarm.setDraft(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
            }}/>
            {swarm.pending ? <button type="button" className="swarm-send" aria-label="Stop sample reply" onClick={swarm.stop}><Square size={12}/></button> : <button type="submit" className="swarm-send" aria-label="Send Swarm message" disabled={!swarm.draft.trim()}><ArrowUp size={16} strokeWidth={2.4}/></button>}
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
            {addingTask && <form className="swarm-add-task-form" onSubmit={event => { event.preventDefault(); if (!taskTitle.trim()) return; swarm.addTask(taskTitle.trim(), taskAssignee); setTaskTitle(''); closeTaskForm() }}>
              <input ref={taskInput} autoFocus value={taskTitle} onChange={event => setTaskTitle(event.target.value)} aria-label="New task name" placeholder="Name the next step" maxLength={180} required/>
              <div><select aria-label="Assign new task" value={taskAssignee} onChange={event => setTaskAssignee(event.target.value as AgentName)}>{project.members.map(name => <option key={name} value={name}>{name}</option>)}</select><button type="submit" disabled={!taskTitle.trim()}>Add</button><button type="button" aria-label="Cancel new task" onClick={closeTaskForm}><X size={13}/></button></div>
            </form>}
            <div className="swarm-tasks">
            {visibleTasks.map(task => <article key={task.id} className="swarm-task" data-status={task.status} aria-label={`${task.title}, ${task.assignee}, ${STATUS_LABEL[task.status]}`}>
              <h4>{task.title}</h4>
              <div className="swarm-task-controls">
                <div className="swarm-task-owner"><Face name={task.assignee}/><select aria-label={`Assignee for ${task.title}`} value={task.assignee} onChange={event => swarm.assignTask(task.id, event.target.value as AgentName)}>{project.members.map(name => <option key={name} value={name}>{name}</option>)}</select></div>
                <select className="swarm-task-status" aria-label={`Status for ${task.title}`} value={task.status} onChange={event => swarm.updateTask(task.id, event.target.value as Task['status'])}>{(Object.keys(STATUS_LABEL) as Task['status'][]).map(status => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}</select>
              </div>
              <div className="swarm-task-actions"><button type="button" onClick={() => openThread(task.assignee)} aria-label={`Discuss ${task.title} with ${task.assignee}`}>Message {task.assignee}</button>
                {task.chatId && validChats.has(task.chatId) && <button type="button" onClick={() => onOpenChat(task.chatId!)}>Open saved work</button>}
              </div>
              <details className="swarm-task-details"><summary><span>Details</span><time dateTime={new Date(task.updatedAt).toISOString()} title={new Date(task.updatedAt).toLocaleString()}>Updated {new Date(task.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></summary><p>{task.summary}</p></details>
            </article>)}
            {visibleTasks.length === 0 && <div className="swarm-work-empty"><strong>No work in this chat yet</strong><p>Choose “Track work” on a message, or add a task to this conversation.</p></div>}
          </div></section>
          <details className="swarm-board-context-details" key={project.id}><summary>Shared project brief</summary><p className="swarm-brief">{project.brief}</p></details>
        </aside>}
      </div>
    </>}
  </section>
}
