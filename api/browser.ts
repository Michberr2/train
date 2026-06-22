// Nalu Browser — Vercel Node serverless function ("Screen executor").
// Drives a REAL browser to do a task (open Gmail, book a reservation, manage an
// inbox) and returns a LIVE, embeddable view of it. The browser can't run in a
// Vercel tab, so it runs remotely. Two backends, in priority order:
//   1. Browser Use Cloud  — set BROWSER_USE_API_KEY (free key, no Docker).
//      Hosted: returns a live_url the chat embeds; you watch + take over for 2FA.
//   2. Self-hosted        — NALU_BROWSER_BASE_URL + NALU_BROWSER_API_KEY
//      (scripts/serve-browser.py) returns a result + screenshots.

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const BU_KEY = env('BROWSER_USE_API_KEY') || env('BROWSERUSE_API_KEY') || ''
const B_BASE = (env('NALU_BROWSER_BASE_URL') || '').replace(/\/+$/, '')
const B_KEY = env('NALU_BROWSER_API_KEY') || ''

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  let body: Record<string, unknown> = {}
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}
  } catch {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }
  const task = typeof body.task === 'string' ? body.task.trim() : ''
  const startUrl = typeof body.url === 'string' ? body.url : ''
  if (!task) {
    res.status(400).json({ error: 'task required' })
    return
  }

  try {
    // 1) Browser Use Cloud — hosted, returns an embeddable live view immediately.
    if (BU_KEY) {
      const upstream = await fetch('https://api.browser-use.com/api/v1/run-task', {
        method: 'POST',
        headers: { Authorization: `Bearer ${BU_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: startUrl ? `Go to ${startUrl}. Then: ${task}` : task }),
      })
      const text = await upstream.text()
      if (!upstream.ok) {
        res.status(502).json({ error: `Browser upstream ${upstream.status}: ${text.slice(0, 300)}` })
        return
      }
      let d: { task_id?: string; status?: string; live_url?: string } = {}
      try {
        d = JSON.parse(text)
      } catch {
        res.status(502).json({ error: 'bad browser response' })
        return
      }
      if (!d.live_url) {
        res.status(502).json({ error: 'no live session returned' })
        return
      }
      res.status(200).json({ live_url: d.live_url, task_id: d.task_id, status: d.status, name: 'Nalu Browser' })
      return
    }

    // 2) Self-hosted browser-use service.
    if (B_BASE && B_KEY) {
      const upstream = await fetch(`${B_BASE}/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${B_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, url: startUrl }),
      })
      const text = await upstream.text()
      if (!upstream.ok) {
        res.status(502).json({ error: `Browser upstream ${upstream.status}: ${text.slice(0, 300)}` })
        return
      }
      let data: { result?: string; screenshots?: string[]; steps?: string[]; url?: string } = {}
      try {
        data = JSON.parse(text)
      } catch {
        res.status(502).json({ error: 'bad browser response' })
        return
      }
      res.status(200).json({
        result: data.result || '',
        screenshots: Array.isArray(data.screenshots) ? data.screenshots.slice(-6) : [],
        steps: Array.isArray(data.steps) ? data.steps : [],
        url: data.url || '',
        name: 'Nalu Browser',
      })
      return
    }

    res.status(501).json({
      error:
        'The Screen executor isn’t connected to a browser yet. Add a free BROWSER_USE_API_KEY (cloud.browser-use.com — no card) and it works instantly, or self-host scripts/serve-browser.py with NALU_BROWSER_BASE_URL + NALU_BROWSER_API_KEY.',
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'browser error' })
  }
}
