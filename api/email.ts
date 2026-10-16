// Email generation only; delivery remains a separate, user-controlled action.
import { cors } from './_cors'
import { providerChain } from './_llm'
import { generateStudioJson } from './_studioGeneration'
import { identityForRequest } from './_db'
import { pickDesign, designPayload } from './_design'
import { EMAIL_CRAFT, wordCount } from './_style'
import { writingContext, WRITING_FIDELITY } from './_writingContext'

const LLM_MODEL = process.env.NALU_EMAIL_MODEL?.trim() || 'thinkingmachines/Inkling'
type Email = { to: string; subject: string; body: string }
function parseEmail(text: string): Email | null {
  try {
    const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const value = JSON.parse(clean)
    if (!value || typeof value.body !== 'string' || !value.body.trim() || typeof value.subject !== 'string' || typeof value.to !== 'string') return null
    if (/[\r\n]/.test(value.to) || /[\r\n]/.test(value.subject)) return null
    return { to: value.to.trim(), subject: value.subject.trim(), body: value.body.trim() }
  } catch { return null }
}
const FORMAT = 'Return ONLY JSON: {"to":"recipient email or empty string","subject":"subject line","body":"complete plain text email with line breaks"}. No commentary or markdown fences.'

export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  if (!providerChain(LLM_MODEL).length) { res.status(500).json({ error: 'Nalu engine is not configured.' }); return }
  const deadlineMs = Date.now() + 170000
  let body: Record<string, unknown>
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {} } catch { res.status(400).json({ error: 'invalid JSON' }); return }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { res.status(400).json({ error: 'invalid request' }); return }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) { res.status(400).json({ error: 'prompt required' }); return }
  if (JSON.stringify(body).length > 220000) { res.status(413).json({ error: 'This email brief is too large. Split the source material so none of it is silently dropped.' }); return }
  const previous = body.prevEmail ? parseEmail(typeof body.prevEmail === 'string' ? body.prevEmail : JSON.stringify(body.prevEmail)) : null
  if (body.prevEmail && !previous) { res.status(400).json({ error: 'The previous email could not be read. Please reopen its chat and retry.' }); return }
  try {
    const who = await identityForRequest(req).catch(() => null)
    const context = await writingContext(body, who)
    const record = `${context.text}\n\n${who ? `SENDER IDENTITY (only when writing from the user): ${JSON.stringify({ name: who.name })}\n` : ''}${previous ? `EXISTING EMAIL TO REVISE:\n${JSON.stringify(previous)}\n\n` : ''}LATEST USER REQUEST:\n${prompt}`
    const allowed = new Set((record.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(v => v.toLowerCase()))
    let feedback = ''
    const parse = (text: string) => {
      const email = parseEmail(text)
      if (!email) return null
      if (email.to && (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email.to) || !allowed.has(email.to.toLowerCase()))) return null
      // Request a rewrite instead of deleting a whole sentence (which may
      // contain the user's actual ask). Explicit supplied wording is exempt.
      const fluff = /\b(?:I )?hope (?:this (?:email|message) finds you well|you(?:'re| are) (?:doing well|having a (?:good|great|wonderful) (?:week|day)))\b|\b(?:please )?(?:do not|don't) hesitate to reach out\b/gi
      for (const match of email.body.matchAll(fluff)) if (!record.toLowerCase().includes(match[0].toLowerCase())) {
        feedback = `Your previous attempt added unrequested filler: ${JSON.stringify(match[0])}. Rewrite with the substantive point immediately after the greeting. Do not add any hope-you-are-well opener or generic closing offer. Preserve the actual requested facts and ask.`
        // Style feedback belongs in the final edit. Do not discard a correct
        // draft or fail the user's whole request over an optional greeting.
      }
      return email
    }
    const draft = await generateStudioJson({
      model: LLM_MODEL, deadlineMs, maxTokens: 5000, temperature: 0.35, maxCallMs: 45000,
      messages: attempt => [
        { role: 'system', content: `You are Nalu Email. Write one complete email that achieves the user's purpose. ${EMAIL_CRAFT}\n${FORMAT}\n${WRITING_FIDELITY}${attempt ? '\nReturn complete valid JSON. Recipient must be a supplied email address or empty; never infer an address from a name. ' + feedback : ''}` },
        { role: 'user', content: record },
      ], parse,
    })
    if (!draft) { res.status(502).json({ error: 'Could not finish an email faithful to your brief. Please retry.' }); return }
    const checked = await generateStudioJson({
      model: LLM_MODEL, deadlineMs, maxTokens: 5000, temperature: 0.1, maxCallMs: 35000,
      messages: () => [
        { role: 'system', content: `You are the final editor. Return the complete corrected email JSON. Check audience, intent, pronouns/speaker, latest corrections, recipient, exact requested wording, dates, amounts, requested length and tone against the brief. Remove invented facts and promises, restore omitted requirements, and keep unaffected content during an edit. Do not claim the sender is ready to proceed, has completed work, has attached a file, or has agreed terms unless supplied. When the draft is correct return it unchanged. ${EMAIL_CRAFT}\n${FORMAT}\n${WRITING_FIDELITY}` },
        { role: 'user', content: `${record}\n\nDRAFT TO CHECK (not evidence):\n${JSON.stringify(draft)}\n${feedback}` },
      ], parse,
    })
    if (!checked) { res.status(502).json({ error: 'Could not finish checking the email against your instructions. Please retry.' }); return }
    res.status(200).json({ ...checked, words: wordCount(checked.body), design: designPayload(pickDesign(prompt, 'email')), name: 'Nalu Email' })
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'email error' }) }
}
