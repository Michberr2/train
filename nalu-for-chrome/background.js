// Nalu for Chrome — background service worker. Orchestrates the agent loop:
//   snapshot the active tab -> POST it + the goal to Nalu's /api/web -> get the
//   next action -> (confirm if consequential) -> execute it via the content script
//   -> repeat until finish/ask/stop. The side panel is just the UI.

const API = 'https://n4lu.ai/api/web' // agent brain (action: 'agentstep')
const MAX_STEPS = 25

let running = false
let stopFlag = false
let pendingApproval = null // resolver for a confirm prompt
let pendingAnswer = null // resolver for an "ask" prompt
let modelAbort = null
let activeEpoch = 0
chrome.tabs.onActivated?.addListener(() => { activeEpoch++ })

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
    const result = await chrome.tabs.sendMessage(tabId, { type: 'ping' })
    if (result?.protocol !== 2) throw new Error('RELOAD_AFTER_UPDATE')
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      await sleep(250)
      const result = await chrome.tabs.sendMessage(tabId, { type: 'ping' })
      if (result?.protocol !== 2) throw new Error('Reload this tab after updating Nalu for Chrome, then run the task again.')
    } catch (e) {
      throw new Error(e?.message?.startsWith('Reload this tab') ? e.message : 'Cannot access this page (it may be a chrome:// or web-store page).')
    }
  }
}

async function currentDocument(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href })
  const document = results.find(result => result.frameId === 0)
  if (!document?.documentId || typeof document.result !== 'string') throw new Error('Cannot identify this page document.')
  return { id: document.documentId, url: document.result }
}
async function snapshot(tabId) {
  await ensureContent(tabId)
  const document = await currentDocument(tabId)
  const snap = await chrome.tabs.sendMessage(tabId, { type: 'snapshot' }, { documentId: document.id })
  if (!snap?.ok || snap.url !== document.url || !snap.documentKey || !snap.snapshotKey) throw new Error('The page changed while it was being observed.')
  return { ...snap, chromeDocumentId: document.id, tabId }
}
const expectedPage = snap => ({ documentKey: snap.documentKey, snapshotKey: snap.snapshotKey, url: snap.url })
async function validateObservation(tab, snap) {
  if (stopFlag) throw new Error('Stopped.')
  const current = await chrome.tabs.get(tab.id)
  if (!current.active || current.windowId !== tab.windowId || current.url !== snap.url) throw new Error('The observed tab changed. Run again on the intended tab.')
  const document = await currentDocument(tab.id)
  if (document.id !== snap.chromeDocumentId || document.url !== snap.url) throw new Error('The observed document changed. Take a new snapshot.')
  const result = await chrome.tabs.sendMessage(tab.id, { type: 'validate', expected: expectedPage(snap) }, { documentId: snap.chromeDocumentId })
  if (!result?.ok) throw new Error(result?.error || 'The observed page is no longer available.')
  if (stopFlag) throw new Error('Stopped.')
}
async function prepareAction(tab, action, snap) {
  await validateObservation(tab, snap)
  const result = await chrome.tabs.sendMessage(tab.id, { type: 'prepare', action, expected: expectedPage(snap) }, { documentId: snap.chromeDocumentId })
  if (!result?.ok) throw new Error(result?.error || 'Cannot inspect the action target.')
  return result
}
async function executeAction(tab, action, snap, review) {
  await validateObservation(tab, snap)
  // Content dispatch is addressed to the observed Chrome document and rechecks
  // the exact target synchronously. Tab-only CDP Input commands cannot provide
  // that guarantee during navigation, so they are never an execution fallback.
  return chrome.tabs.sendMessage(tab.id, { type: 'act', action, expected: expectedPage(snap), reviewId: review.reviewId }, { documentId: snap.chromeDocumentId })
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(listener)
    const timer = setTimeout(finish, timeout)
  })
}

// Consequential actions need a human OK first (Nalu never spends money / sends /
// deletes without you). Keyword + cross-origin heuristics.
const RISKY = /\b(buy|purchase|pay|payment|checkout|order|subscribe|donate|delete|remove|send|submit|post|confirm|book|transfer|withdraw|sign\s?out|log\s?out|place order)\b/i
function needsConfirm(action, snap, review = {}) {
  const target = review.target || (snap.elements || []).find(el => el.ref === action.ref)
  if (action.type === 'click_at' || action.type === 'closetab') return true
  if (action.type === 'type' && action.submit) {
    // The intent comes from the actual control/form, never the words typed into
    // it. A benign message such as "Hello" can still send mail or submit a buy.
    return !(target?.form?.search && !RISKY.test(target.form.text || '') && !RISKY.test(target.text || ''))
  }
  if (action.type === 'click') {
    if (!target) return true
    if (RISKY.test([target.text, target.href, target.form?.text].filter(Boolean).join(' '))) return true
    if (target.form && (target.inputType === 'submit' || target.tag === 'button')) return !target.form.search
    // A button named "Continue" may still submit a JS-only payment/message UI.
    // Only ordinary same-site links and disclosure toggles have a known benign
    // default here; unknown scripted controls require action-specific review.
    if (target.tag === 'summary') return false
    if (target.tag === 'a' && target.href) {
      try { return new URL(target.href).origin !== new URL(snap.url).origin } catch { return true }
    }
    return true
  }
  if (action.type === 'navigate' || action.type === 'newtab') {
    try { return new URL(snap.url).origin !== new URL(action.url).origin } catch { return true }
  }
  return false
}

function askApproval(action, snap, review) {
  const id = crypto.randomUUID()
  return new Promise(resolve => {
    pendingApproval = { id, resolve }
    toPanel('confirm', { id, action, url: snap.url, target: review?.target?.text || '' })
  })
}
function askUser(question) {
  return new Promise((resolve) => {
    pendingAnswer = resolve
    toPanel('ask', { question })
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
        await validateObservation(tab, snap)
        const epoch = activeEpoch
        screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 45 })
        await validateObservation(tab, snap)
        if (activeEpoch !== epoch) screenshot = ''
      } catch {
        screenshot = '' // never pair another tab's image with this page's DOM
      }

      // Open tabs in this window (multi-tab awareness).
      let tabs = []
      try {
        tabs = (await chrome.tabs.query({ windowId: tab.windowId })).map((t) => ({ id: t.id, index: t.index, title: (t.title || '').slice(0, 60), url: t.url, active: !!t.active }))
      } catch {
        /* ignore */
      }

      let data
      try {
        await validateObservation(tab, snap)
        modelAbort = new AbortController()
        const r = await fetch(API, {
          method: 'POST',
          signal: AbortSignal.any([modelAbort.signal, AbortSignal.timeout(90000)]),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'agentstep', goal, url: snap.url, title: snap.title, text: snap.text, elements: snap.elements, viewport: snap.viewport, screenshot, tabs, history }),
        })
        data = await r.json()
        if (!r.ok) throw new Error(data?.error || `engine ${r.status}`)
      } catch (e) {
        toPanel('error', { message: 'Nalu engine: ' + String((e && e.message) || e) })
        break
      }

      if (stopFlag) break
      await validateObservation(tab, snap)
      const action = data.action || { type: 'finish', summary: 'No action.' }
      if (['navigate', 'newtab'].includes(action.type) && !/^https?:$/.test(new URL(action.url).protocol)) throw new Error('Only HTTP and HTTPS navigation is allowed.')
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
        if (unattended) throw new Error('A scheduled task needs user input; run it interactively to continue.')
        const answer = await askUser(action.question || 'I need more info.')
        history.push({ action, result: `user replied: ${answer}` })
        continue
      }
      const review = await prepareAction(tab, action, snap)
      if (needsConfirm(action, snap, review)) {
        const ok = unattended ? false : await askApproval(action, snap, review)
        if (!ok) {
          history.push({ action, result: unattended ? 'skipped — consequential actions are not auto-approved on scheduled runs' : 'user declined this action' })
          toPanel('step', { thought: unattended ? 'Skipped a consequential step (scheduled runs never auto-approve).' : 'You declined that step — trying another way.', action: { type: 'note' } })
          continue
        }
      }

      await validateObservation(tab, snap)
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
          const target = tabs.find(t => t.index === Number(action.index))
          if (target && target.id != null) {
            const currentTarget = await chrome.tabs.get(target.id)
            if (currentTarget.url !== target.url || currentTarget.windowId !== tab.windowId) throw new Error('The requested tab changed after it was observed.')
            if (stopFlag) break
            await chrome.tabs.update(target.id, { active: true })
            history.push({ action, result: `switched to tab ${action.index} (${(target.title || '').slice(0, 40)})` })
          } else history.push({ action, result: `no tab at index ${action.index}` })
        } catch (e) {
          history.push({ action, result: 'switchtab failed: ' + String((e && e.message) || e) })
        }
        await sleep(400)
      } else if (action.type === 'closetab') {
        try {
          await chrome.tabs.remove(tab.id)
          history.push({ action, result: 'closed the tab' })
        } catch (e) {
          history.push({ action, result: 'closetab failed: ' + String((e && e.message) || e) })
        }
        await sleep(500)
      } else if (action.type === 'navigate' && action.url) {
        try {
          await chrome.tabs.update(tab.id, { url: action.url })
          await waitForLoad(tab.id)
          history.push({ action, result: `navigated to ${action.url}` })
        } catch (e) {
          history.push({ action, result: 'navigate failed: ' + String((e && e.message) || e) })
        }
        await sleep(600)
      } else {
        let res
        try {
          res = await executeAction(tab, action, snap, review)
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) }
        }
        history.push({ action, result: res && res.ok ? res.detail || 'done' : `failed: ${res && res.error}` })
        await sleep(800)
        // a click may have triggered navigation
        await waitForLoad(tab.id, 4000)
      }
      if (history.length > 30) history.splice(0, history.length - 30)
      if (step === MAX_STEPS - 1) toPanel('done', { summary: 'Reached the step limit. Ask me to continue if needed.' })
    }
  } catch (e) {
    toPanel('error', { message: String((e && e.message) || e) })
  }
  modelAbort = null
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.to === 'panel') return
  // Only the extension's own panel may authorize or control the agent. Content
  // scripts in ordinary pages are not an approval surface.
  if (sender?.url !== chrome.runtime.getURL('sidepanel.html')) return
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
    modelAbort?.abort()
    if (pendingAnswer) { pendingAnswer(''); pendingAnswer = null }
    if (pendingApproval) {
      pendingApproval.resolve(false)
      pendingApproval = null
    }
    sendResponse({ ok: true })
  } else if (msg.type === 'approve') {
    if (pendingApproval && msg.id === pendingApproval.id) {
      pendingApproval.resolve(msg.ok === true)
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
