// Nalu for Chrome — side panel UI. Sends the goal to the background worker and
// renders the live step log + confirmation / question prompts it streams back.

const log = document.getElementById('log')
const goalEl = document.getElementById('goal')
const runBtn = document.getElementById('run')
const stopBtn = document.getElementById('stop')
const stateEl = document.getElementById('state')
const promptEl = document.getElementById('prompt')
const tasksEl = document.getElementById('tasks')

let hintShown = true
let thinkingEl = null
let lastGoal = ''

// ── Saved tasks (record / replay) ─────────────────────────────────────────────
function loadTasks() {
  chrome.storage.local.get({ nalu_tasks: [] }, ({ nalu_tasks }) => renderTasks(nalu_tasks))
}
function renderTasks(tasks) {
  if (!tasks || !tasks.length) {
    tasksEl.className = 'tasks hidden'
    tasksEl.innerHTML = ''
    return
  }
  tasksEl.className = 'tasks'
  tasksEl.innerHTML = ''
  for (const t of tasks) {
    const chip = document.createElement('div')
    chip.className = 'task-chip'
    chip.title = 'Run: ' + t.goal
    const label = document.createElement('span')
    label.textContent = t.name || t.goal
    chip.appendChild(label)
    const sched = document.createElement('div')
    const s = t.schedule || 'off'
    sched.className = 'sched' + (s !== 'off' ? ' on' : '')
    sched.textContent = s === 'daily' ? '◷1d' : s === 'hourly' ? '◷1h' : '◷'
    sched.title = 'Schedule (off → daily → hourly)'
    sched.onclick = (e) => {
      e.stopPropagation()
      cycleSchedule(t)
    }
    chip.appendChild(sched)
    const x = document.createElement('div')
    x.className = 'x'
    x.textContent = '×'
    x.onclick = (e) => {
      e.stopPropagation()
      deleteTask(t.id)
    }
    chip.appendChild(x)
    chip.onclick = () => runGoal(t.goal)
    tasksEl.appendChild(chip)
  }
}
function saveTask(goal) {
  if (!goal) return
  chrome.storage.local.get({ nalu_tasks: [] }, ({ nalu_tasks }) => {
    if (nalu_tasks.some((t) => t.goal === goal)) return
    const name = goal.length > 32 ? goal.slice(0, 30).trim() + '…' : goal
    nalu_tasks.unshift({ id: 'task_' + Date.now(), name, goal })
    chrome.storage.local.set({ nalu_tasks: nalu_tasks.slice(0, 20) }, loadTasks)
  })
}
function deleteTask(id) {
  chrome.storage.local.get({ nalu_tasks: [] }, ({ nalu_tasks }) => {
    chrome.runtime.sendMessage({ type: 'schedule', id, schedule: 'off' }) // clear any alarm
    chrome.storage.local.set({ nalu_tasks: nalu_tasks.filter((t) => t.id !== id) }, loadTasks)
  })
}
function cycleSchedule(task) {
  const next = task.schedule === 'daily' ? 'hourly' : task.schedule === 'hourly' ? 'off' : 'daily'
  chrome.storage.local.get({ nalu_tasks: [] }, ({ nalu_tasks }) => {
    const t = nalu_tasks.find((x) => x.id === task.id)
    if (!t) return
    t.schedule = next
    chrome.runtime.sendMessage({ type: 'schedule', id: t.id, goal: t.goal, schedule: next })
    chrome.storage.local.set({ nalu_tasks }, loadTasks)
  })
}
loadTasks()

function clearHint() {
  if (hintShown) {
    log.innerHTML = ''
    hintShown = false
  }
}
function scroll() {
  log.scrollTop = log.scrollHeight
}
function clearThinking() {
  if (thinkingEl) {
    thinkingEl.remove()
    thinkingEl = null
  }
}

function addStep({ step, thought, action, result, cls }) {
  clearHint()
  clearThinking()
  const el = document.createElement('div')
  el.className = 'step' + (cls ? ' ' + cls : '')
  const parts = []
  if (step) parts.push(`<div class="n">Step ${step}</div>`)
  if (thought) parts.push(`<div class="thought">${esc(thought)}</div>`)
  if (action && action.type && action.type !== 'note') parts.push(`<div class="act">${esc(describe(action))}</div>`)
  if (result) parts.push(`<div class="res">${esc(result)}</div>`)
  el.innerHTML = parts.join('')
  log.appendChild(el)
  scroll()
}

function describe(a) {
  switch (a.type) {
    case 'click':
      return `click [${a.ref}]`
    case 'click_at':
      return `click at (${a.x}, ${a.y})`
    case 'type':
      return `type "${a.text || ''}"${a.submit ? ' ⏎' : ''} → [${a.ref}]`
    case 'scroll':
      return `scroll ${a.direction || 'down'}`
    case 'navigate':
      return `navigate ${a.url || ''}`
    case 'newtab':
      return `new tab → ${a.url || ''}`
    case 'switchtab':
      return `switch to tab ${a.index}`
    case 'closetab':
      return `close tab`
    case 'ask':
      return `ask: ${a.question || ''}`
    case 'finish':
      return `finish`
    default:
      return a.type || ''
  }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

function showThinking(step) {
  clearThinking()
  thinkingEl = document.createElement('div')
  thinkingEl.className = 'thinking'
  thinkingEl.innerHTML = `<span class="dot"></span> Nalu is looking at the page (step ${step})…`
  log.appendChild(thinkingEl)
  scroll()
}

function setRunning(on) {
  runBtn.classList.toggle('hidden', on)
  stopBtn.classList.toggle('hidden', !on)
  stateEl.textContent = on ? 'running' : 'idle'
  stateEl.classList.toggle('running', on)
  runBtn.disabled = false
}

function showConfirm(action, review) {
  promptEl.className = 'prompt'
  promptEl.innerHTML = `
    <div class="q">Nalu wants to do something consequential. Allow it?</div>
    <div class="actbox">${esc(describe(action))}<br>${esc(review.url || "")}${review.target ? `<br>Target: ${esc(review.target)}` : ""}</div>
    <div class="btns"><button class="approve">Allow</button><button class="decline">Skip</button></div>`
  promptEl.querySelector('.approve').onclick = () => {
    chrome.runtime.sendMessage({ type: 'approve', id: review.id, ok: true })
    hidePrompt()
  }
  promptEl.querySelector('.decline').onclick = () => {
    chrome.runtime.sendMessage({ type: 'approve', id: review.id, ok: false })
    hidePrompt()
  }
}
function showAsk(question) {
  promptEl.className = 'prompt'
  promptEl.innerHTML = `
    <div class="q">${esc(question)}</div>
    <input type="text" id="answer" placeholder="Type your answer…" />
    <div class="btns"><button class="send">Send</button></div>`
  const input = promptEl.querySelector('#answer')
  input.focus()
  const send = () => {
    chrome.runtime.sendMessage({ type: 'answer', text: input.value })
    hidePrompt()
  }
  promptEl.querySelector('.send').onclick = send
  input.onkeydown = (e) => {
    if (e.key === 'Enter') send()
  }
}
function hidePrompt() {
  promptEl.className = 'prompt hidden'
  promptEl.innerHTML = ''
}

function runGoal(goal) {
  goal = (goal || '').trim()
  if (!goal) return
  lastGoal = goal
  goalEl.value = goal
  clearHint()
  addStep({ thought: `Goal: ${goal}`, cls: '' })
  chrome.runtime.sendMessage({ type: 'run', goal })
  setRunning(true)
}
function addSaveBar(goal) {
  const bar = document.createElement('div')
  bar.className = 'savebar'
  const b = document.createElement('button')
  b.textContent = '＋ Save as task'
  b.onclick = () => {
    saveTask(goal)
    b.textContent = '✓ Saved — it’s in the bar above'
    b.disabled = true
  }
  bar.appendChild(b)
  log.appendChild(bar)
  scroll()
}
runBtn.onclick = () => runGoal(goalEl.value)
stopBtn.onclick = () => {
  chrome.runtime.sendMessage({ type: 'stop' })
}
goalEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runBtn.click()
})

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.to !== 'panel') return
  const { ev, data } = msg
  if (ev === 'status') {
    setRunning(data.state === 'running')
  } else if (ev === 'thinking') {
    showThinking(data.step)
  } else if (ev === 'step') {
    addStep({ step: data.step, thought: data.thought, action: data.action })
  } else if (ev === 'confirm') {
    showConfirm(data.action, data)
  } else if (ev === 'ask') {
    showAsk(data.question)
  } else if (ev === 'done') {
    addStep({ thought: data.summary, cls: 'done', step: '' })
    if (lastGoal) addSaveBar(lastGoal)
    setRunning(false)
  } else if (ev === 'error') {
    addStep({ thought: data.message, cls: 'err' })
    setRunning(false)
  }
})
