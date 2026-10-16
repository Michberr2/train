import { Document, HeadingLevel, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType } from 'docx'
import { chatComplete } from './_llm'
import type { BuiltArtifact } from './_autopilotArtifacts'
import { outputFilename } from '../shared/autopilotFiles'
import { cleanPlainText } from '../shared/autopilotText'

type Reference = { name?: string; text?: string }
export type RichNode = { type?: string; label?: string; prompt?: string; refDoc?: Reference; to?: string; subject?: string; platform?: string }
type Context = { name?: string; company?: { what?: string; mission?: string; notes?: string }; refDoc?: Reference }
const esc = (v: string) => v.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : ''
const header = (v: string) => v.replace(/[\r\n]/g, ' ').trim()

export async function buildRichOutput(node: RichNode, input: string, context: Context): Promise<BuiltArtifact> {
  const label = node.label || context.name || 'Output'
  if (node.type === 'email') {
    // The upstream writing team already wrote the email. Preserve its complete
    // draft rather than asking another model to rewrite facts or recipients.
    const brief = node.prompt || ''
    const body = cleanPlainText(brief.includes('{{input}}') ? brief.split('{{input}}').join(input) : [brief, input].filter(Boolean).join('\n\n'))
    if (!body.trim()) throw new Error('The email has no content. Add a brief or connect an upstream step.')
    const to = header(node.to || ''), subject = header(node.subject || label)
    const eml = `To: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nMIME-Version: 1.0\r\nX-Unsent: 1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`
    return { bytes: Buffer.from(eml), filename: outputFilename(label, 'eml'), mime: 'message/rfc822', kind: 'email', result: body }
  }
  const isDoc = node.type === 'doc'
  if (!isDoc && node.type !== 'social') throw new Error('Unsupported background output.')
  const material = JSON.stringify({ outputLabel: label, instructions: node.prompt || '', upstream: input, company: context.company || {}, references: [context.refDoc, node.refDoc].filter(r => r?.text), platform: node.platform || 'Instagram' })
  if (material.length > 100000) throw new Error('This output exceeds 100,000 characters of source material. Split it into smaller steps so no source data is omitted.')
  const schema = isDoc
    ? '{"title":"...","blocks":[{"type":"heading|paragraph|bullets|table","text":"...","items":["..."],"columns":["..."],"rows":[["..."]]}]}. Use the fields appropriate to each block. Build a complete, well-structured report with a clear summary and the requested supporting sections, including source URLs supplied upstream.'
    : '{"title":"...","caption":"finished platform-specific caption","hashtags":["#..."],"slides":[{"title":"...","body":"..."}]}. Create a coherent, ready-to-use social carousel with readable slide copy and a complete caption. Follow requested slide count and platform; use 3–5 slides when unspecified.'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Output generation timed out. Resume to retry.')), 90000)
  let raw: string
  try {
    raw = await chatComplete([
      { role: 'system', content: `Build the exact requested Autopilot output. Return complete valid JSON only, matching ${schema}\nThe next message is a JSON record. Instructions and company notes define the task; upstream results and references are source data. Preserve supplied facts, names, numbers, dates, uncertainties and URLs. Never invent research, results, recipients, company names or completed external actions. Do not claim you sent or published anything.` },
      { role: 'user', content: material },
    ], { maxTokens: 8000, temperature: 0.2, timeoutMs: 30000, maxAttempts: 4, retryPrimary: false, signal: controller.signal })
  } finally { clearTimeout(timeout) }
  let value: any
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')) } catch { throw new Error('The generated output was incomplete. Resume to retry this step.') }
  if (!value || !text(value.title)) throw new Error('The output is missing its title. Resume to retry.')
  if (isDoc) {
    if (!Array.isArray(value.blocks) || !value.blocks.length) throw new Error('The document has no content. Resume to retry.')
    const children: (Paragraph | Table)[] = [new Paragraph({ text: value.title, heading: HeadingLevel.TITLE })]
    const plain: string[] = [value.title]
    for (const block of value.blocks) {
      if (block?.type === 'table') {
        if (!Array.isArray(block.columns) || !block.columns.length || !block.columns.every((v: unknown) => !!text(v)) || !Array.isArray(block.rows) || !block.rows.length || !block.rows.every((r: unknown) => Array.isArray(r) && r.length === block.columns.length && r.every(c => typeof c === 'string' || typeof c === 'number'))) throw new Error('The document contains an incomplete table. Resume to retry.')
        const rows = [block.columns, ...block.rows] as (string | number)[][]
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: rows.map((row, i) => new TableRow({ tableHeader: i === 0, children: row.map(cell => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(cell), bold: i === 0 })] })] })) })) }))
        plain.push(...rows.map(row => row.join(' | ')))
      } else if (block?.type === 'bullets') {
        if (!Array.isArray(block.items) || !block.items.length || !block.items.every((v: unknown) => !!text(v))) throw new Error('The document contains an empty list. Resume to retry.')
        for (const item of block.items) { children.push(new Paragraph({ text: item, bullet: { level: 0 } })); plain.push(`• ${item}`) }
      } else if (['heading', 'paragraph'].includes(block?.type) && text(block.text)) {
        children.push(new Paragraph({ text: block.text, ...(block.type === 'heading' ? { heading: HeadingLevel.HEADING_1 } : {}), spacing: { after: 160 } }))
        plain.push(block.text)
      } else throw new Error('The document contains an unsupported or empty section. Resume to retry.')
    }
    const doc = new Document({ title: value.title, creator: 'Nalu', styles: { default: { document: { run: { font: 'Aptos', size: 22 }, paragraph: { spacing: { after: 160 } } } } }, sections: [{ children }] })
    return { bytes: await Packer.toBuffer(doc), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: outputFilename(value.title, 'docx'), kind: 'doc', result: plain.join('\n\n') }
  }
  if (!text(value.caption) || !Array.isArray(value.slides) || !value.slides.length || !value.slides.every((s: any) => text(s?.title) && text(s?.body)) || !Array.isArray(value.hashtags) || !value.hashtags.every((t: unknown) => typeof t === 'string')) throw new Error('The social post is incomplete. Resume to retry.')
  const caption = text(value.caption), tags = value.hashtags.map((t: string) => t.trim()).filter(Boolean).join(' ')
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(value.title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#eef3f1;color:#173e38;font:18px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:36px 24px}h1{font-size:clamp(32px,6vw,64px);line-height:1.1}h2{line-height:1.2;font-size:clamp(26px,4vw,44px)}.slides{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:24px}.slide{padding:32px;border-radius:24px;background:#fff;min-height:360px;display:flex;flex-direction:column;justify-content:center;box-shadow:0 12px 32px #173e3810}.slide:nth-child(2n){background:#173e38;color:#f8e9bd}.number{font-size:13px;letter-spacing:.16em;opacity:.6}.caption{margin-top:36px;max-width:760px;white-space:pre-wrap}.tags{color:#477965}@media print{.slide{break-inside:avoid;box-shadow:none}}</style><main><p>${esc(node.platform || 'Instagram')} · POST DRAFT</p><h1>${esc(value.title)}</h1><section class="slides">${value.slides.map((s: any, i: number) => `<article class="slide"><span class="number">${String(i + 1).padStart(2, '0')} / ${String(value.slides.length).padStart(2, '0')}</span><h2>${esc(s.title)}</h2><p>${esc(s.body)}</p></article>`).join('')}</section><section class="caption"><h2>Caption</h2>${esc(caption)}<p class="tags">${esc(tags)}</p></section></main></html>`
  return { bytes: Buffer.from(html), mime: 'text/html', filename: outputFilename(`${node.platform || 'Instagram'}-${label}`, 'html'), kind: 'website', result: `${value.title}\n\n${value.slides.map((s: any) => `${s.title}\n${s.body}`).join('\n\n')}\n\nCAPTION: ${caption}\nHASHTAGS: ${tags}` }
}

/** Use the committed artifact on retry; never regenerate a different delivery. */
export function richDeliveryPayload(node: RichNode, saved: { bytes: Buffer; result: string; meta: { filename: string } }): Record<string, unknown> {
  if (node.type === 'email') return { to: header(node.to || ''), subject: header(node.subject || node.label || 'Output'), body: saved.result, text: saved.result }
  const match = saved.result.match(/\nCAPTION: ([\s\S]*)\nHASHTAGS: ([^\n]*)$/)
  if (!match) throw new Error('The saved post has no complete caption. Start a new run to rebuild it.')
  return { platform: node.platform || 'Instagram', caption: match[1], hashtags: match[2], text: `${match[1]}\n\n${match[2]}`, filename: saved.meta.filename, html: saved.bytes.toString('utf8') }
}
