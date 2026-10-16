// Nalu writing craft — shared email style guide + a deterministic "de-slop" pass.
//
// Two things live here:
//   1. EMAIL_CRAFT — the system-prompt guidance that makes Nalu Email top-tier:
//      a real length-decision framework (short by default; earn every extra line),
//      plain-English craft rules, and an explicit ban list of the filler AI reflexively
//      adds ("I hope this email finds you well", "just wanted to reach out", "delve",
//      "leverage", "circle back", "please don't hesitate to reach out", …).
//   2. deSlop() — a conservative post-processor that STRIPS the most common tells even
//      when the model slips. It only deletes clearly-standalone filler sentences and makes
//      safe word swaps, so it can never mangle real content. Belt-and-suspenders.

export const EMAIL_CRAFT = `HOW TO WRITE A TOP-TIER EMAIL:

LENGTH — decide it deliberately; DEFAULT TO SHORT. Most email is read in seconds on a phone by a busy person, and reply rates fall as length rises. Aim for ~50–125 words (about 3–5 short sentences) for anything that asks for a reply or an action.
- Keep it SHORT for: cold outreach or a first contact; asking for something (a favor, a decision, a meeting, an intro, a payment); a follow-up or nudge; a status update, confirmation, or scheduling; anything to a senior or very busy person; internal logistics; sales/prospecting. One idea, one ask.
- Go LONGER only when the reader genuinely needs the detail to act — a proposal or recommendation with real trade-offs; a decision that needs full context; onboarding or step-by-step instructions; a newsletter or announcement; sensitive news (an apology, bad news, a negotiation) where tone and completeness matter; or a briefing the reader asked for. Even then stay tight and SCANNABLE: bottom line up front, short paragraphs, bullets, and bold the one line that matters. Length must be earned by real information, never by throat-clearing or padding.

ENGLISH & CRAFT:
- BLUF — bottom line up front. Lead with the point or the ask in the first sentence. No runway.
- One email, one purpose, one clear call to action.
- Subject line: specific and useful — state the ask or the value ("15 min Thu re: Q3 pricing", "Invoice 4021 — due Fri"). Never "Touching base", "Quick question", "Checking in", "Following up".
- The first line must earn the read. Don't open with a greeting-pleasantry and don't restate the subject.
- Short paragraphs (1–3 sentences). Plain words. Active voice. Concrete specifics — real dates, times, numbers, names ("Thursday 2pm ET", not "sometime soon").
- Warm but never obsequious; confident, not stiff. Match the register to the relationship.
- End with ONE explicit next step ("Can you approve by Friday?", "Grab 20 min here: <link>").
- Cut ~20%. If a sentence doesn't move the ask forward, delete it.

NEVER WRITE THESE (the filler that marks writing as auto-generated) — write the real content instead:
- Opener fluff: "I hope this email finds you well", "I hope you're doing well", "I hope you had a great weekend", "I wanted to reach out", "I'm reaching out", "I am writing to you today", "Just wanted to check in / touch base", "As per my last email".
- Corporate filler: "In today's fast-paced world", "in the ever-evolving landscape of", "at the end of the day", "it goes without saying", "needless to say", "it's worth noting that", "that being said" (as filler), "please find attached" (say what it is).
- Slop words/clichés: "delve", "leverage" (as a verb — use "use"), "utilize", "synergy", "circle back", "touch base", "move the needle", "low-hanging fruit", "think outside the box", "boil the ocean", "streamline", "robust", "seamless".
- Closer fluff: "Please don't hesitate to reach out", "feel free to reach out with any questions", "I'd be more than happy to", "Thank you for your time and consideration", "Rest assured", "Kindly". Use "Looking forward to hearing from you" only when it names a real next step.
- No emoji in a professional email, no exclamation-point spam, no "not only… but also", no "As an AI". Never use em dashes or en dashes ("—" / "–") — use a comma, period, parentheses, or a plain hyphen "-" instead (Nalu house style).

SIGN-OFF: one that fits ("Thanks,", "Best,", "— <Name>", or "Cheers," when casual). Don't stack pleasantries. Use the sender's real name if given, otherwise a clean placeholder like "[Your name]".`

// ---- deterministic de-slop --------------------------------------------------
// Whole-sentence filler that is safe to DELETE (it carries no real content). Each must
// match a complete sentence/clause so removing it never truncates a real one.
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

// Safe word/phrase swaps — plainer English, grammar preserved. [pattern, replacement].
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

// Remove clearly-standalone filler sentences, apply safe swaps, and tidy the whitespace
// / punctuation left behind — WITHOUT ever cutting real content. Idempotent.
export function deSlop(input: string): string {
  if (!input || typeof input !== 'string') return input || ''
  // Work line by line so we preserve paragraph/line breaks (emails rely on them).
  const lines = input.split('\n').map((line) => {
    let s = line
    for (const re of FILLER_SENTENCES) s = s.replace(re, '')
    for (const [re, rep] of SWAPS) s = s.replace(re, rep)
    // Nalu house style: no em/en dashes. Processed per-line, so this never eats a
    // paragraph break. " word — word " → " word - word ".
    s = s.replace(/\s*[—–]\s*/g, ' - ')
    // Tidy: strip leading horizontal space a removed opener left behind (email bodies
    // don't use meaningful indentation), collapse doubled spaces, fix orphaned
    // punctuation-space, trim trailing space.
    s = s.replace(/^[ \t]+/, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/[ \t]+$/g, '')
    // If removing a leading filler sentence left the line starting lowercase, capitalize.
    s = s.replace(/^([a-z])/, (_m, c: string) => c.toUpperCase())
    return s
  })
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // no more than one blank line between blocks
    .replace(/^\n+/, '') // no leading blank lines (e.g. a deleted opener)
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

// Count words (for a subtle length indicator + the SHORT-by-default check).
export function wordCount(s: string): number {
  return (s || '').trim().split(/\s+/).filter(Boolean).length
}
