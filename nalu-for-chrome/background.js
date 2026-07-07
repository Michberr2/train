// Nalu for Chrome — background service worker. Orchestrates the agent loop:
//   snapshot the active tab -> POST it + the goal to Nalu's /api/agent -> get the
//   next action -> (confirm if consequential) -> execute it via the content script
//   -> repeat until finish/ask/stop. The side panel is just the UI.

const API = 'https://n4lu.ai/api/web' // agent brain (action: 'agentstep')
const MAX_STEPS = 25

let running = false
let stopFlag = false
let pendingApproval = null // resolver for a confirm prompt
let pendingAnswer = null // resolver for an "ask" prompt

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {})
})
chrome.action?.onClicked?.addListener((tab) => {
  if (tab && tab.windowId != null) chrome.sidePanel?.open?.({ windowId: tab.windowId }).catch(() => {})
})

function toPanel(ev, data) {
  chrome.runtime.sendMessage({ to: 'panel', ev, data }).catch(() => {})
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
  return t
}

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' })
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      await sleep(250)
    } catch (e) {
      throw new Error('Cannot access this page (it may be a chrome:// or web-store page).')
    }
  }
}

async function snapshot(tabId) {
  await ensureContent(tabId)
  return await chrome.tabs.sendMessage(tabId, { type: 'snapshot' })
}
async function execute(tabId, action) {
  return await chrome.tabs.sendMessage(tabId, { type: 'act', action })
}

// ── CDP (chrome.debugger) — robust real input on sites that block synthetic
// events. Best-effort: if attach/send fails, we fall back to the content script.
const cdpAttached = new Set()
function cdpSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const e = chrome.runtime.lastError
      if (e) reject(new Error(e.message))
      else resolve(res)
    })
  })
}
function cdpAttach(tabId) {
  if (cdpAttached.has(tabId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const e = chrome.runtime.lastError
      if (e && !/already attached/i.test(e.message)) {
        resolve(false)
      } else {
        cdpAttached.add(tabId)
        resolve(true)
      }
    })
  })
}
function cdpDetach(tabId) {
  if (!cdpAttached.has(tabId)) return Promise.resolve()
  cdpAttached.delete(tabId)
  return new Promise((r) => chrome.debugger.detach({ tabId }, () => r()))
}
chrome.debugger.onDetach.addListener((src) => {
  if (src && src.tabId != null) cdpAttached.delete(src.tabId)
})
async function cdpClickAt(tabId, x, y) {
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

// Execute one action: clicks go through CDP for reliability; everything else
// (type/scroll) goes through the content script. CDP failures fall back.
async function executeAction(tabId, action, snap) {
  if (action.type === 'click' || action.type === 'click_at') {
    let x = action.x
    let y = action.y
    if (action.type === 'click') {
      const el = (snap.elements || []).find((e) => e.ref === action.ref)
      if (el) {
        x = el.x
        y = el.y
      }
    }
    if (x != null && y != null && (await cdpAttach(tabId))) {
      try {
        await cdpClickAt(tabId, Number(x), Number(y))
        return { ok: true, detail: `clicked (${x}, ${y}) via CDP` }
      } catch {
        /* fall through to the content-script click */
      }
    }
  }
  return await execute(tabId, action)
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(finish, timeout)
  })
}

// Consequential actions need a human OK first (Nalu never spends money / sends /
// deletes without you). Keyword + cross-origin heuristics.
const RISKY = /\b(buy|purchase|pay|payment|checkout|order|subscribe|donate|delete|remove|send|submit|post|confirm|book|transfer|withdraw|sign\s?out|log\s?out|place order)\b/i
function needsConfirm(action, snap) {
  if (action.type === 'type' && action.submit) {
    // searching is fine; submitting a form with sensitive context is not
    return RISKY.test(snap.text || '') && RISKY.test((action.text || '') + ' ')
  }
  if (action.type === 'click') {
    const el = (snap.elements || []).find((e) => e.ref === action.ref)
    if (el && RISKY.test(el.text || '')) return true
  }
  if (action.type === 'navigate') {
    try {
      const cur = new URL(snap.url).host
      const next = new URL(action.url).host
      return cur !== next
    } catch {
      return true
    }
  }
  return false
}

function askApproval(action) {
  toPanel('confirm', { action })
  return new Promise((resolve) => {
    pendingApproval = resolve
  })
}
function askUser(question) {
  toPanel('ask', { question })
  return new Promise((resolve) => {
    pendingAnswer = resolve
  })
}

async function runAgent(goal, unattended = false) {
  if (running) return
  running = true
  stopFlag = false
  toPanel('status', { state: 'running', goal })
  const history = []
  const recentSigs = []
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (stopFlag) {
        toPanel('done', { summary: 'Stopped.' })
        break
      }
      const tab = await activeTab()
      if (!tab || !tab.id) throw new Error('No active tab.')
      toPanel('thinking', { step: step + 1 })
      let snap
      try {
        snap = await snapshot(tab.id)
      } catch (e) {
        toPanel('error', { message: String((e && e.message) || e) })
        break
      }
      // Vision grounding: a screenshot of the current viewport, so the model can
      // SEE the page (handles canvas / custom UIs and disambiguates elements).
      let screenshot = ''
      try {
        screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 45 })
      } catch {
        /* some pages can't be captured — DOM-only fallback */
      }

      // Open tabs in this window (multi-tab awareness).
      let tabs = []
      try {
        tabs = (await chrome.tabs.query({ currentWindow: true })).map((t) => ({ index: t.index, title: (t.title || '').slice(0, 60), url: t.url, active: !!t.active }))
      } catch {
        /* ignore */
      }

      let data
      try {
        const r = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'agentstep', goal, url: snap.url, title: snap.title, text: snap.text, elements: snap.elements, viewport: snap.viewport, screenshot, tabs, history }),
        })
        data = await r.json()
        if (!r.ok) throw new Error(data?.error || `engine ${r.status}`)
      } catch (e) {
        toPanel('error', { message: 'Nalu engine: ' + String((e && e.message) || e) })
        break
      }

      const action = data.action || { type: 'finish', summary: 'No action.' }
      toPanel('step', { step: step + 1, thought: data.thought || '', action })

      // Loop-guard: if it proposes the same action 3 times in a row, it's stuck.
      const sig = JSON.stringify(action)
      recentSigs.push(sig)
      if (recentSigs.length > 3) recentSigs.shift()
      if (recentSigs.length === 3 && recentSigs.every((s) => s === sig) && action.type !== 'finish' && action.type !== 'ask') {
        toPanel('done', { summary: 'I kept trying the same step without progress, so I stopped. Try rephrasing the goal, or do that step manually and run me again.' })
        break
      }

      if (action.type === 'finish') {
        toPanel('done', { summary: action.summary || data.thought || 'Done.' })
        break
      }
      if (action.type === 'ask') {
        const answer = await askUser(action.question || 'I need more info.')
        history.push({ action, result: `user replied: ${answer}` })
        continue
      }
      if (needsConfirm(action, snap)) {
        const ok = unattended ? false : await askApproval(action)
        if (!ok) {
          history.push({ action, result: unattended ? 'skipped — consequential actions are not auto-approved on scheduled runs' : 'user declined this action' })
          toPanel('step', { thought: unattended ? 'Skipped a consequential step (scheduled runs never auto-approve).' : 'You declined that step — trying another way.', action: { type: 'note' } })
          continue
        }
      }

      const t2 = await activeTab()
      if (action.type === 'newtab' && action.url) {
        try {
          const nt = await chrome.tabs.create({ url: action.url, active: true })
          await waitForLoad(nt.id)
          history.push({ action, result: `opened a new tab: ${action.url}` })
        } catch (e) {
          history.push({ action, result: 'newtab failed: ' + String((e && e.message) || e) })
        }
        await sleep(600)
      } else if (action.type === 'switchtab') {
        try {
          const all = await chrome.tabs.query({ currentWindow: true })
          const target = all.find((t) => t.index === Number(action.index)) || all[Number(action.index)]
          if (target && target.id != null) {
            await chrome.tabs.update(target.id, { active: true })
            history.push({ action, result: `switched to tab ${action.index} (${(target.title || '').slice(0, 40)})` })
          } else history.push({ action, result: `no tab at index ${action.index}` })
        } catch (e) {
          history.push({ action, result: 'switchtab failed: ' + String((e && e.message) || e) })
        }
        await sleep(400)
      } else if (action.type === 'closetab') {
        try {
          await chrome.tabs.remove(t2.id)
          history.push({ action, result: 'closed the tab' })
        } catch (e) {
          history.push({ action, result: 'closetab failed: ' + String((e && e.message) || e) })
        }
        await sleep(500)
      } else if (action.type === 'navigate' && action.url) {
        try {
          await chrome.tabs.update(t2.id, { url: action.url })
          await waitForLoad(t2.id)
          history.push({ action, result: `navigated to ${action.url}` })
        } catch (e) {
          history.push({ action, result: 'navigate failed: ' + String((e && e.message) || e) })
        }
        await sleep(600)
      } else {
        let res
        try {
          res = await executeAction(t2.id, action, snap)
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) }
        }
        history.push({ action, result: res && res.ok ? res.detail || 'done' : `failed: ${res && res.error}` })
        await sleep(800)
        // a click may have triggered navigation
        await waitForLoad(t2.id, 4000)
      }
      if (history.length > 30) history.splice(0, history.length - 30)
      if (step === MAX_STEPS - 1) toPanel('done', { summary: 'Reached the step limit. Ask me to continue if needed.' })
    }
  } catch (e) {
    toPanel('error', { message: String((e && e.message) || e) })
  }
  // Release the debugger from any tab we attached (removes the banner).
  for (const id of [...cdpAttached]) await cdpDetach(id)
  running = false
  stopFlag = false
  pendingApproval = null
  pendingAnswer = null
  toPanel('status', { state: 'idle' })
}

// Scheduled tasks (chrome.alarms). The alarm name encodes the saved task id.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || !alarm.name.startsWith('nalu_task_')) return
  if (running) return
  const id = alarm.name.slice('nalu_task_'.length)
  const { nalu_tasks = [] } = await chrome.storage.local.get({ nalu_tasks: [] })
  const task = nalu_tasks.find((t) => t.id === id)
  if (!task) {
    chrome.alarms.clear(alarm.name)
    return
  }
  await runAgent(task.goal, true) // unattended → never auto-approves consequential steps
  try {
    chrome.notifications?.create?.({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'Nalu finished a scheduled task', message: task.name || task.goal })
  } catch {
    /* notifications optional */
  }
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.to === 'panel') return
  if (msg.type === 'run') {
    runAgent(String(msg.goal || ''))
    sendResponse({ ok: true })
  } else if (msg.type === 'schedule') {
    const name = 'nalu_task_' + msg.id
    chrome.alarms.clear(name)
    if (msg.schedule === 'hourly') chrome.alarms.create(name, { delayInMinutes: 60, periodInMinutes: 60 })
    else if (msg.schedule === 'daily') chrome.alarms.create(name, { delayInMinutes: 1440, periodInMinutes: 1440 })
    sendResponse({ ok: true })
  } else if (msg.type === 'stop') {
    stopFlag = true
    if (pendingApproval) {
      pendingApproval(false)
      pendingApproval = null
    }
    sendResponse({ ok: true })
  } else if (msg.type === 'approve') {
    if (pendingApproval) {
      pendingApproval(!!msg.ok)
      pendingApproval = null
    }
    sendResponse({ ok: true })
  } else if (msg.type === 'answer') {
    if (pendingAnswer) {
      pendingAnswer(String(msg.text || ''))
      pendingAnswer = null
    }
    sendResponse({ ok: true })
  }
  return true
})
