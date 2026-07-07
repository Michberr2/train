// Shared grounding helper (not an API route — leading underscore).
// If a build request references a URL, fetch that page live and return a block to
// prepend to the prompt, so generated docs / decks / sheets / sites are based on
// the real source instead of guesses. Best-effort; returns '' if nothing usable.

function firstUrl(prompt: string): string | null {
  const m = prompt.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"')<>]*/i)
  if (m) return m[0]
  const dom = prompt.match(/\b([a-z0-9-]{2,}\.(?:com|ai|io|co|net|org|app|dev|gov|edu|xyz))\b/i)
  return dom ? `https://${dom[1].toLowerCase()}` : null
}

async function fetchText(url: string, ms: number): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'text/html,*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    })
    return r.ok ? await r.text() : ''
  } catch {
    return ''
  } finally {
    clearTimeout(t)
  }
}

/** Fetch a URL named in the prompt (rendered via the Jina reader, raw HTML as
 *  fallback) and return a "base your build on THIS" reference block, or ''. */
export async function groundFromPrompt(prompt: string): Promise<string> {
  const url = firstUrl(prompt)
  if (!url) return ''
  let txt = await fetchText('https://r.jina.ai/' + url, 11000)
  if (!txt || txt.length < 120) {
    const raw = await fetchText(url, 6000)
    txt = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
  }
  txt = txt
    .replace(/^Title:[^\n]*\n/m, '')
    .replace(/^URL Source:[^\n]*\n/m, '')
    .replace(/^Markdown Content:\s*/im, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
  if (txt.length < 80) return ''
  return (
    `REFERENCE SOURCE — fetched live just now from ${url}. Base what you build on THIS source: use its real facts, names, figures, structure, wording and details, and do NOT invent anything that conflicts with it. If the user also gives instructions, follow them on top of this source.\n\n${txt}\n\n----\n\nThe request:\n`
  )
}
