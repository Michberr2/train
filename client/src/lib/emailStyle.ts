// Client mirror of the server's deterministic email de-slop (api/_style.ts deSlop).
// Kept in sync deliberately: the AutoPilot Email node builds its body from upstream
// agent text (not /api/email), so it needs the same safety net to strip the filler AI
// reflexively adds ("I hope this finds you well", "please don't hesitate to reach out",
// "utilize", "circle back", …) WITHOUT ever cutting real content.

const FILLER_SENTENCES: RegExp[] = [
  /\bI hope (this|the|my) (e-?mail|message|note|email) finds you (well|doing well)\b[^.!?\n]*[.!?]/gi,
  /\bI hope this finds you well\b[^.!?\n]*[.!?]/gi,
  /\bI hope (you'?re|you are|things are|all is|everything is) (doing )?(well|great|going well)\b[^.!?\n]*[.!?]/gi,
  /\bI hope you('?re| are)? (had|having|have) (a )?(great|good|wonderful|nice|lovely) (weekend|week|day|day so far)\b[^.!?\n]*[.!?]/gi,
  /\bI (just )?wanted to (quickly )?(reach out|check in|touch base)\b[^.!?\n]*[.!?]/gi,
  /\bI'?m reaching out\b[^.!?\n]*[.!?]/gi,
  /\bPlease (do not|don'?t) hesitate to (reach out|contact me|ask|get in touch)\b[^.!?\n]*[.!?]/gi,
  /\b(Please )?feel free to reach out\b[^.!?\n]*[.!?]/gi,
  /\bThank you for your time and consideration\b[^.!?\n]*[.!?]/gi,
  /\bRest assured\b[^,.!?\n]*[,.!?]/gi,
  /\bAs an AI( language model)?\b[^.!?\n]*[.!?]/gi,
  /\bIt goes without saying\b[^,.!?\n]*[,.!?]/gi,
  /\bNeedless to say\b[^,.!?\n]*[,.!?]/gi,
]

const SWAPS: [RegExp, string][] = [
  [/\butilizing\b/gi, 'using'],
  [/\butilized\b/gi, 'used'],
  [/\butilizes\b/gi, 'uses'],
  [/\butilize\b/gi, 'use'],
  [/\bin order to\b/gi, 'to'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bin the event that\b/gi, 'if'],
  [/\ba large number of\b/gi, 'many'],
  [/\bprior to\b/gi, 'before'],
  [/\bin a timely manner\b/gi, 'promptly'],
  [/\bat your earliest convenience\b/gi, 'when you can'],
  [/\bcircle back\b/gi, 'follow up'],
  [/\btouch base\b/gi, 'talk'],
]

/** Strip standalone filler sentences + apply safe word swaps. Never cuts real content. */
export function deSlop(input: string): string {
  if (!input || typeof input !== 'string') return input || ''
  const lines = input.split('\n').map((line) => {
    let s = line
    for (const re of FILLER_SENTENCES) s = s.replace(re, '')
    for (const [re, rep] of SWAPS) s = s.replace(re, rep)
    s = s.replace(/\s*[—–]\s*/g, ' - ') // Nalu house style: no em/en dashes (per-line, safe)
    s = s.replace(/^[ \t]+/, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/[ \t]+$/g, '')
    s = s.replace(/^([a-z])/, (_m, c: string) => c.toUpperCase())
    return s
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/[ \t]+\n/g, '\n').trim()
}

export function wordCount(s: string): number {
  return (s || '').trim().split(/\s+/).filter(Boolean).length
}
