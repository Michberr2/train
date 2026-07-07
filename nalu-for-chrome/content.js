// Nalu for Chrome — content script. Lives on every page; on request it (1) takes
// a DOM "snapshot" of the visible interactive elements (each given a numeric ref)
// and the visible text, and (2) executes an action (click / type / scroll) by ref.
// DOM-grounded control: reliable refs, not pixel guessing.

(() => {
  if (window.__naluContentLoaded) return
  window.__naluContentLoaded = true

  let REFS = new Map()

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
      el.value ||
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
      const r = el.getBoundingClientRect()
      const item = { ref, tag, role, text, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      if (el.value) item.value = String(el.value).slice(0, 60)
      out.push(item)
      ref++
    }
    const bodyText = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 2600)
    return {
      ok: true,
      url: location.href,
      title: document.title,
      text: bodyText,
      elements: out,
      viewport: { w: Math.round(innerWidth), h: Math.round(innerHeight), dpr: window.devicePixelRatio || 1 },
    }
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
        el.scrollIntoView({ block: 'center', behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' })
        el.focus && el.focus()
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
          for (const t of ['keydown', 'keypress', 'keyup']) {
            el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
          }
          const form = el.closest && el.closest('form')
          if (form && form.requestSubmit) {
            try {
              form.requestSubmit()
            } catch {
              /* ignore */
            }
          }
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
        el.scrollIntoView({ block: 'center' })
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
    } else if (msg && msg.type === 'act') {
      send(act(msg.action))
    } else if (msg && msg.type === 'ping') {
      send({ ok: true })
    }
    return true // async response
  })
})()
