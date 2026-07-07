// Nalu document builder — Vercel Node serverless function.
// Turns a request ("build me a business plan…") into a structured, well-organized
// document (title, headings, paragraphs, bullets, tables) that the client renders
// and exports to .docx (Word) / .pdf. Branded "Nalu Docs"; provider hidden.

import { cors } from './_cors'
import { groundFromPrompt } from './_grounding'
import { chatCompleteContinued } from './_llm'
import { identityForRequest, identityBlock } from './_db'
import { normalizeChart } from './_validate'
import { reserveStudioQuota, studioLimitMessage } from './_limits'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_KEY = env('TINKER_API_KEY') || ''
const LLM_MODEL = env('NALU_DOC_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

const SYSTEM = `You are a world-class business writer and document designer.
Produce exactly the document the user asks for (business plan, report, proposal, essay, letter, memo, etc.) — thorough, well-structured, and professional.

HOUSE STYLE — quiet, timeless luxury (think Four Seasons / Hillpointe): refined and editorial, calm and confident, never loud. Polished, precise prose; elegant restraint; generous structure with clear hierarchy. The "cover" photo description must be of that calibre — serene, architectural, premium, cinematic (e.g. "sunlit modern residential community at golden hour, manicured landscaping, calm and aspirational"), never a cheap or busy stock scene.

IDENTITY: If the document is about "Nalu" — or about the assistant/company itself, or no company is named — the company is **Nalu** (brand "Nalu AI", website n4lu.ai). Use the name Nalu / Nalu AI consistently. NEVER invent or substitute a different company name (e.g. never "Nexus", "Nexus AI", "Acme", etc.). Only use a different company name if the USER explicitly names one. NEVER use emojis, emoticons, or decorative symbols (no ✅ ✓ ❌ → • ★ etc.) anywhere in the output — clean professional typography only.

Output ONLY valid minified JSON (no markdown fences, no prose) of this exact shape:
{"title": string, "subtitle": string, "cover": string, "blocks": [ Block ]}
where "cover" is a vivid one-line PHOTO description for the document's cover page background (a real, specific, photogenic scene tied to the topic — e.g. "aerial view of a modern residential development at golden hour" — NOT a logo or chart; the app generates the photo from this)
COVER RULES — a photo cover is ONLY for editorial/branded documents. Set "cover" to "" (empty string) for FORMAL documents where a photo would look unprofessional:
  - NO cover ("" always): legal documents (contracts, agreements, NDAs, leases, briefs, memoranda of law, policies, terms), financial statements & reports (P&L, balance sheets, budgets, audits, invoices, investment memos, financial plans), scientific/academic papers, letters/memos/emails, résumés/CVs, government/compliance filings, meeting minutes.
  - YES cover (REQUIRED — these must ship with a beautiful cover): business plans, proposals, pitch documents, marketing/brand documents, travel guides, event programs, books, magazines, lifestyle/editorial reports, strategy decks-as-docs.
  - Formal documents still get FULL data richness — tables and charts wherever they carry the analysis (a financial plan should be dense with tables/charts; it just has no photo).
where each Block is one of:
  {"type":"heading","level":1|2|3,"text":string}
  {"type":"paragraph","text":string}
  {"type":"bullets","items":[string]}
  {"type":"table","columns":[string],"rows":[[string]]}
  {"type":"chart","chart":{"type":"bar|line|pie","title":string,"labels":[string],"series":[{"name":string,"values":[number]}]}}

DEPTH — thorough and professional, but COMPLETE and never cut off (this matters more than length):
- MATCH THE STRUCTURE TO THE DOCUMENT TYPE — never force a business-plan shape onto everything:
  - Reports / business plans / proposals / strategy → 5–8 level-1 sections opening with a concise Executive Summary (2–3 paragraphs); a business plan covers e.g. Market & Opportunity, Product, Business Model, Go-to-Market, Financials, Milestones, Risks. Include 1 chart + 2–3 tables of real, internally-consistent data.
  - Letters / cover letters / memos / emails → proper correspondence format (date, greeting, body paragraphs, sign-off). NO executive summary, NO charts/tables, no heading-on-every-line — just well-written prose.
  - Essays / articles / op-eds → an engaging title, a compelling opening, well-developed body paragraphs that build a clear argument, and a real conclusion. Charts/tables only if the topic genuinely calls for data.
  - How-tos / guides / SOPs → prerequisites, clear ordered steps, and practical tips.
- Every section: real, specific analysis with concrete numbers and named examples — no one-liners, no filler, no lorem ipsum. Bullets for genuine lists; rich paragraphs for analysis.
- Use "chart"/"table" blocks ONLY where they add real value for THIS document type (a plan or report: yes; a condolence letter or essay: usually none). When you include them, use real, internally-consistent numbers.
- "subtitle" may be an empty string.
CRITICAL: the output MUST be a single COMPLETE, valid minified JSON object — finish every block and close all brackets/quotes. If you are running long, wrap up and close the JSON rather than getting cut off. Favor a complete document over an extra section.`

function repairJson(s: string): string {
  let inStr = false
  let esc = false
  const stack: string[] = []
  let lastSafe = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') { inStr = false; lastSafe = i + 1 }
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') { stack.pop(); lastSafe = i + 1 }
    else if (ch === ',') lastSafe = i + 1
  }
  let out = s.slice(0, lastSafe).replace(/[\s,]+$/, '')
  out = out.replace(/,?\s*"(?:\\.|[^"\\])*"\s*:\s*[^,{}[\]]*$/, '')
  out = out.replace(/[\s,]+$/, '')
  while (stack.length) out += stack.pop()
  return out
}

function extractJson(text: string): unknown | null {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const i = t.indexOf('{')
  if (i === -1) return null
  const j = t.lastIndexOf('}')
  if (j > i) {
    try { return JSON.parse(t.slice(i, j + 1)) } catch { /* repair */ }
  }
  try { return JSON.parse(repairJson(t.slice(i))) } catch { return null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// Formal document types NEVER get a photo cover (belt over the prompt rule).
const FORMAL_NO_COVER =
  /\b(contract|agreement|nda|non.disclosure|lease|terms (of|and)|policy|policies|memorandum|legal (doc|brief|memo)|complaint|motion|affidavit|bylaws|operating agreement|will and testament|compliance|filing|p&l|profit (and|&) loss|balance sheet|income statement|cash flow statement|budget|audit|invoice|financial (statement|report|plan|memo)|investment memo|prospectus|term sheet|cap table|scientific|research paper|journal|thesis|dissertation|lab report|résumé|resume|\bcv\b|cover letter|memo\b|meeting minutes)\b/i
const stripFormalCover = <T extends { cover?: string; title?: string }>(out: T, ask: string): T => {
  if (FORMAL_NO_COVER.test(ask) || FORMAL_NO_COVER.test(String(out?.title || ''))) return { ...out, cover: '' }
  return out
}

// ---- LONG-FORM PIPELINE (books, scientific articles, legal documents) ------
// One LLM call caps out around ~15 pages. Long-form works get an OUTLINE call
// (chapter plan) and then one SECTION call per chapter, orchestrated by the
// client — hundreds of pages with no cap, rendered progressively.
const SYSTEM_OUTLINE = `You are a master editor planning a complete long-form work (book, scientific article, legal document, textbook, or comprehensive report). Design the FULL structure — every chapter/section that a definitive version of this work would contain.

Output ONLY valid minified JSON: {"title":string,"subtitle":string,"cover":string,"kind":"book"|"scientific"|"legal"|"report","chapters":[{"heading":string,"brief":string,"targetWords":number}]}
- "cover": one vivid photo description for the cover background (premium, cinematic, tied to the topic).
- "kind": book = narrative/chaptered; scientific = a real journal-article structure (Abstract, Introduction, Background/Related Work, Methods, Results, Discussion, Limitations, Conclusion, References — adapt to the field); legal = a real legal-instrument structure (parties/recitals, definitions, operative articles, representations, remedies, boilerplate, signature blocks — or brief/memo structure when asked); report = major analytical sections.
- "brief": 2-4 sentences telling the section writer EXACTLY what this chapter covers, its key points, and how it connects to neighbours (so the whole reads as one coherent work).
- "targetWords": realistic per-chapter word count (books 1500-3000; scientific sections 400-1500; legal articles 300-1200).
- HONOR the user's requested length/chapter count exactly when given; otherwise choose what the work genuinely needs (a book: 12-28 chapters; do NOT undersize).
- Same identity and no-emoji rules as always. Chapters array may be up to 48 long.`

const SYSTEM_SECTION = `You are writing ONE chapter/section of a larger work whose outline is fixed. Write it COMPLETELY and at full professional depth — this text goes straight into the final document.

Output ONLY valid minified JSON: {"blocks":[Block]} using the same Block shapes as a document ({"type":"heading","level":1|2|3,"text"}, {"type":"paragraph","text"}, {"type":"bullets","items"}, {"type":"table","columns","rows"}, {"type":"chart",...}).
- START with a level-1 heading = the chapter heading you were given (unless told it is a title/abstract section).
- Hit the target word count (within ±20%) with REAL substance: developed argument or narrative, specific facts, numbers, examples, named sources where relevant. Never filler, never summaries of what you will say — say it.
- Scientific sections: rigorous academic register; cite real, well-known works inline (Author, Year) and, in a References section, give properly formatted citations to REAL published literature you are confident exists — never fabricate plausible-sounding citations; fewer real ones beat many invented ones.
- Legal sections: precise operative language, defined terms used consistently, numbered articles/sections (e.g. "3.1", "3.2"), jurisdiction-aware; note where jurisdiction-specific review is required.
- Books: vivid, continuous prose that flows from the previous chapter summary you are given; keep characters, tone and facts consistent with the context.
- Use level-2/3 headings to structure within the chapter. Tables/charts only where they genuinely help.
- No emojis or decorative symbols. Write the COMPLETE chapter.`

export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  if (!LLM_KEY) {
    res.status(500).json({ error: 'Nalu engine is not configured.' })
    return
  }

  let body: Record<string, unknown> = {}
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}
  } catch {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    res.status(400).json({ error: 'prompt required' })
    return
  }
  const mode = typeof body.mode === 'string' ? body.mode : ''
  const who = await identityForRequest(req).catch(() => null)
  const whoLine = identityBlock(who)
  // Follow-up edit: revise the existing document instead of regenerating.
  const prevDoc = typeof body.prevDoc === 'string' && body.prevDoc.length > 50 ? body.prevDoc.slice(0, 90000) : ''

  // If the request references a link, fetch it and build FROM that source.
  const grounded = await groundFromPrompt(prompt)

  if (mode === 'outline' || mode === 'section') {
    const quotaL = await reserveStudioQuota(req, 'doc')
    if (!quotaL.ok) {
      res.status(429).json({ error: studioLimitMessage('document', quotaL) })
      return
    }
    try {
      if (mode === 'outline') {
        const { content } = await chatCompleteContinued(
          [
            { role: 'system', content: SYSTEM_OUTLINE + whoLine },
            { role: 'user', content: grounded + prompt },
          ],
          { model: LLM_MODEL, maxTokens: 6000, timeoutMs: 120000, retryPrimary: false, temperature: 0.4, json: true },
        )
        let o = extractJson(content) as { title?: string; cover?: string; kind?: string; chapters?: unknown[] } | null
        if (o) {
          o = stripFormalCover(o, prompt)
          if (o.kind === 'scientific' || o.kind === 'legal') o.cover = ''
        }
        if (!o || !Array.isArray(o.chapters) || !o.chapters.length) {
          await quotaL.release()
          res.status(502).json({ error: 'outline failed' })
          return
        }
        res.status(200).json(o)
        return
      }
      // mode === 'section'
      const heading = typeof body.heading === 'string' ? body.heading : ''
      const brief = typeof body.brief === 'string' ? body.brief : ''
      const docTitle = typeof body.docTitle === 'string' ? body.docTitle : ''
      const docKind = typeof body.docKind === 'string' ? body.docKind : 'report'
      const context = typeof body.context === 'string' ? body.context.slice(0, 6000) : ''
      const targetWords = Math.max(200, Math.min(3500, Number(body.targetWords) || 1200))
      const idx = Number(body.index) || 0
      const total = Number(body.total) || 0
      const userMsg = `THE WORK: "${docTitle}" (${docKind}). Original request: ${prompt.slice(0, 1500)}\n\nYOU ARE WRITING chapter ${idx + 1} of ${total}: "${heading}"\nCHAPTER BRIEF: ${brief}\nTARGET: ~${targetWords} words.${context ? `\n\nWHAT CAME BEFORE (summaries — stay consistent, do not repeat):\n${context}` : ''}`
      // Two attempts server-side (bad JSON happens) — a long build must not
      // lose chapters to a single flaky response.
      let secBlocks: unknown[] | null = null
      for (let attempt = 0; attempt < 2 && !secBlocks; attempt++) {
        const { content } = await chatCompleteContinued(
          [
            { role: 'system', content: SYSTEM_SECTION + whoLine + (attempt ? '\nYour previous reply was not valid JSON — output ONLY the minified {"blocks":[...]} object.' : '') },
            { role: 'user', content: userMsg },
          ],
          { model: LLM_MODEL, maxTokens: 12000, timeoutMs: 200000, retryPrimary: false, temperature: attempt ? 0.3 : 0.5, json: true },
        )
        const sec = extractJson(content) as { blocks?: unknown[] } | null
        if (sec && Array.isArray(sec.blocks) && sec.blocks.length) secBlocks = sec.blocks
      }
      if (!secBlocks) {
        await quotaL.release()
        res.status(502).json({ error: 'section failed' })
        return
      }
      res.status(200).json({ blocks: secBlocks })
      return
    } catch (err) {
      await quotaL.release()
      res.status(500).json({ error: err instanceof Error ? err.message : 'long-form error' })
      return
    }
  }

  // Images the user attached (captioned client-side by the vision model). The
  // model can't SEE them, so we give it captions + an index and let it place
  // each one as an image block by `ref`; the client swaps ref → the real image.
  const imageList = Array.isArray(body.images)
    ? (body.images as Array<{ caption?: string }>).filter((x) => x && typeof x === 'object')
    : []
  const imgInstr = imageList.length
    ? `\n\nThe user attached ${imageList.length} image(s). Place EACH one where it best supports the document using an image block:
  {"type":"image","ref":<index>,"caption":string}
where <index> is the 0-based index below and caption is a short, specific caption. Use every image at least once, in a sensible spot near related text (do NOT bunch them all at the end).
Attached images:
${imageList.map((im, i) => `  [${i}] ${(typeof im.caption === 'string' && im.caption.trim()) || 'user-provided image'}`).join('\n')}`
    : ''

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const dateLine = `\n\nToday's date is ${today}. Use it wherever a date is needed (letter dates, "as of", report dates, timelines) — never invent or omit a date.`

  // Generate once; if the JSON can't be parsed (rare truncation), retry once
  // with a slightly tighter nudge — so docs don't intermittently fail. Robust:
  // timeout + provider failover + truncation continuation; low temp + JSON mode.
  const gen = async (extra: string): Promise<{ title?: string; subtitle?: string; cover?: string; blocks?: unknown[] } | null> => {
    const { content } = await chatCompleteContinued(
      [
        { role: 'system', content: whoLine + (prevDoc ? SYSTEM + '\n\nREVISION MODE: the user has an EXISTING document (JSON below) and a change request. Apply the change faithfully and PRESERVE everything not mentioned — same title/blocks/data unless the request touches them. Output the complete updated JSON.' : SYSTEM) + dateLine + extra },
        { role: 'user', content: grounded + prompt + (prevDoc ? `\n\n----\nCURRENT DOCUMENT JSON:\n${prevDoc}` : '') },
      ],
      { model: LLM_MODEL, maxTokens: 11000, timeoutMs: 90000, retryPrimary: false, temperature: 0.4, json: true },
    )
    return extractJson(content) as { title?: string; subtitle?: string; cover?: string; blocks?: unknown[] } | null
  }

  const quota = await reserveStudioQuota(req, 'doc')
  if (!quota.ok) {
    res.status(429).json({ error: studioLimitMessage('document', quota) })
    return
  }
  let succeeded = false
  try {
    let parsed = await gen(imgInstr)
    if (!parsed || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
      parsed = await gen(imgInstr + '\n\nIMPORTANT: keep it focused (5–6 sections) and ensure the JSON is COMPLETE and valid — do not get cut off.')
    }
    if (!parsed || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
      res.status(502).json({ error: 'Could not build the document. Try rephrasing.' })
      return
    }
    // Coerce any chart blocks to finite numbers (drop unusable ones) so a chart
    // never renders blank from a "$4.2M"-style string value.
    const blocks = parsed.blocks
      .map((b) => {
        if (b && typeof b === 'object' && (b as { type?: string }).type === 'chart') {
          const nc = normalizeChart((b as { chart?: unknown }).chart)
          return nc ? { type: 'chart', chart: nc } : null
        }
        return b
      })
      .filter(Boolean)
    res.status(200).json(
      stripFormalCover(
        {
          title: parsed.title || 'Document',
          subtitle: parsed.subtitle || '',
          cover: typeof parsed.cover === 'string' ? parsed.cover : '',
          blocks,
          name: 'Nalu Docs',
        },
        prompt,
      ),
    )
    succeeded = true
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'doc error' })
  } finally {
    if (!succeeded) await quota.release()
  }
}
