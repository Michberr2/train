// Nalu for Chrome — content script. Lives on every page; on request it (1) takes
// a DOM "snapshot" of the visible interactive elements (each given a numeric ref)
// and the visible text, and (2) executes an action (click / type / scroll) by ref.
// DOM-grounded control: reliable refs, not pixel guessing.

(() => {
  if (window.__naluContentLoaded) return
  window.__naluContentLoaded = true

  let REFS = new Map()
  let OBSERVED = new Map()
  const documentKey = crypto.randomUUID()
  let snapshotKey = ''
  let snapshotUrl = ''
  const prepared = new Map()

  const isVisible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
    if (el.disabled) return false
    // On-screen-ish: within a screen above/below the viewport (so we can scroll to it).
    if (r.bottom < -50 || r.top > innerHeight + 50) return false
    return true
  }

  const labelOf = (el) => {
    const tag = el.tagName.toLowerCase()
    let t =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : el.innerText) ||
      (el.type === 'password' ? 'Password field' : el.value) ||
      ''
    t = (t || '').replace(/\s+/g, ' ').trim()
    if (!t && el.name) t = el.name
    return t.slice(0, 120)
  }

  const SEL = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'textarea',
    'select',
    'summary',
    '[role=button]',
    '[role=link]',
    '[role=tab]',
    '[role=menuitem]',
    '[role=checkbox]',
    '[role=switch]',
    '[contenteditable=true]',
    '[onclick]',
  ].join(',')

  // Collect matching elements across the document AND open shadow roots, so
  // elements inside web components (YouTube, many modern apps) are seen too.
  function collectInteractive() {
    const acc = []
    const walk = (root, depth) => {
      if (depth > 15 || !root || !root.querySelectorAll) return
      try {
        for (const el of root.querySelectorAll(SEL)) acc.push(el)
      } catch {
        /* ignore */
      }
      try {
        for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot, depth + 1)
      } catch {
        /* ignore */
      }
    }
    walk(document, 0)
    return acc
  }

  function snapshot() {
    REFS = new Map()
    OBSERVED = new Map()
    prepared.clear()
    snapshotKey = crypto.randomUUID()
    snapshotUrl = location.href
    const out = []
    let ref = 1
    const seen = new Set()
    for (const el of collectInteractive()) {
      if (ref > 120) break
      if (seen.has(el) || !isVisible(el)) continue
      seen.add(el)
      const tag = el.tagName.toLowerCase()
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? el.type || 'text' : tag)
      const text = labelOf(el)
      // Skip dead, unlabeled non-inputs.
      if (!text && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue
      REFS.set(ref, el)
      OBSERVED.set(ref, fingerprint(el))
      const r = el.getBoundingClientRect()
      const item = { ref, tag, role, text, ...actionContext(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      if (el.value && el.type !== 'password') item.value = String(el.value).slice(0, 60)
      out.push(item)
      ref++
    }
    const bodyText = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 2600)
    return {
      ok: true,
      documentKey,
      snapshotKey,
      url: location.href,
      title: document.title,
      text: bodyText,
      elements: out,
      viewport: { w: Math.round(innerWidth), h: Math.round(innerHeight), dpr: window.devicePixelRatio || 1 },
    }
  }

  function actionContext(el) {
    const form = el.form || el.closest?.('form')
    const method = (form?.method || 'get').toLowerCase()
    const formText = (form?.innerText || '').replace(/\s+/g, ' ').slice(0, 1000)
    const isSearch = !!form && method === 'get' && (form.getAttribute('role') === 'search' || !!form.querySelector('input[type="search"]'))
    return { inputType: el.type || '', href: el.href || '', form: form ? { method, action: form.action || location.href, text: formText, search: isSearch } : null }
  }

  function fingerprint(el) {
    const rect = el.getBoundingClientRect()
    return JSON.stringify({ label: labelOf(el), tag: el.tagName, role: el.getAttribute('role'), value: el.value, editable: el.isContentEditable ? el.textContent : '', context: actionContext(el), rect: [rect.x, rect.y, rect.width, rect.height], disabled: el.disabled })
  }

  function targetAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null
    let el = document.elementFromPoint(x, y)
    while (el?.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner }
    return el
  }

  function checkObservation(expected) {
    if (!expected || expected.documentKey !== documentKey || expected.snapshotKey !== snapshotKey || expected.url !== location.href || snapshotUrl !== location.href) throw new Error('The observed page changed. Take a fresh snapshot before acting.')
  }

  function prepare(action, expected) {
    try {
      checkObservation(expected)
      let el = null
      if (action.type === 'click' || action.type === 'type') {
        el = REFS.get(action.ref)
        if (!el?.isConnected || !isVisible(el) || OBSERVED.get(action.ref) !== fingerprint(el)) throw new Error('The target changed after the snapshot.')
      } else if (action.type === 'click_at') {
        el = targetAt(Number(action.x), Number(action.y))
        if (!el?.isConnected) throw new Error('No target at these coordinates.')
      }
      const reviewId = crypto.randomUUID()
      prepared.clear()
      prepared.set(reviewId, { action: JSON.stringify(action), el, fingerprint: el ? fingerprint(el) : '', expected })
      return { ok: true, reviewId, target: el ? { text: labelOf(el), tag: el.tagName.toLowerCase(), ...actionContext(el) } : null }
    } catch (error) { return { ok: false, error: error.message } }
  }

  function checkedAction(action, expected, reviewId) {
    try {
      checkObservation(expected)
      const review = prepared.get(reviewId)
      prepared.delete(reviewId) // one-shot: no duplicate submission on retry
      if (!review || review.action !== JSON.stringify(action)) throw new Error('The action does not match its review.')
      if (review.el && (!review.el.isConnected || fingerprint(review.el) !== review.fingerprint || action.type === 'click_at' && targetAt(Number(action.x), Number(action.y)) !== review.el)) throw new Error('The reviewed target changed. Take a fresh snapshot.')
      // Validation and dispatch share one JS turn in this exact document. A new
      // document cannot receive an old action via a tab-only native-input call.
      return act(action)
    } catch (error) { return { ok: false, error: error.message } }
  }

  // Set a value the way React/Vue controlled inputs expect (native setter + events).
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')
    if (setter && setter.set) setter.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function act(action) {
    try {
      const type = action.type
      if (type === 'click') {
        const el = REFS.get(action.ref)
        if (!el) return { ok: false, error: `no element with ref ${action.ref}` }
        el.click()
        return { ok: true, detail: `clicked "${labelOf(el) || action.ref}"` }
      }
      if (type === 'type') {
        const el = REFS.get(action.ref)
        if (!el) return { ok: false, error: `no element with ref ${action.ref}` }
        el.scrollIntoView({ block: 'center' })
        el.focus()
        if (el.isContentEditable) {
          el.textContent = action.text || ''
          el.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          setValue(el, action.text || '')
        }
        if (action.submit) {
          const form = el.form || (el.closest && el.closest('form'))
          if (form && form.requestSubmit) {
            form.requestSubmit()
          } else for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
        }
        return { ok: true, detail: `typed "${(action.text || '').slice(0, 40)}" into "${labelOf(el) || action.ref}"${action.submit ? ' + Enter' : ''}` }
      }
      if (type === 'click_at') {
        // Vision fallback: click whatever is at viewport CSS coords (x,y) — for
        // canvas / custom-drawn UIs with no DOM ref.
        const x = Number(action.x)
        const y = Number(action.y)
        let el = document.elementFromPoint(x, y)
        // Pierce open shadow roots to the deepest element at that point.
        while (el && el.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint(x, y)
          if (!inner || inner === el) break
          el = inner
        }
        if (!el) return { ok: false, error: `nothing at (${x}, ${y})` }
        const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }
        el.dispatchEvent(new MouseEvent('mousedown', opts))
        el.dispatchEvent(new MouseEvent('mouseup', opts))
        el.dispatchEvent(new MouseEvent('click', opts))
        return { ok: true, detail: `clicked at (${x}, ${y}) → "${labelOf(el) || el.tagName.toLowerCase()}"` }
      }
      if (type === 'scroll') {
        const d = action.direction || 'down'
        if (d === 'top') scrollTo({ top: 0, behavior: 'smooth' })
        else if (d === 'bottom') scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
        else scrollBy({ top: d === 'up' ? -innerHeight * 0.85 : innerHeight * 0.85, behavior: 'smooth' })
        return { ok: true, detail: `scrolled ${d}` }
      }
      return { ok: false, error: `unknown action ${type}` }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg && msg.type === 'snapshot') {
      send(snapshot())
    } else if (msg && msg.type === 'prepare') {
      send(prepare(msg.action, msg.expected))
    } else if (msg && msg.type === 'validate') {
      try { checkObservation(msg.expected); send({ ok: true }) } catch (error) { send({ ok: false, error: error.message }) }
    } else if (msg && msg.type === 'act') {
      send(checkedAction(msg.action, msg.expected, msg.reviewId))
    } else if (msg && msg.type === 'ping') {
      send({ ok: true, protocol: 2 })
    }
    return true // async response
  })
})()
