export const PORTABLE_OUTPUT_TYPES = ['textfile', 'markdown', 'json', 'calendar', 'mailrules', 'contacts'] as const
export type PortableOutputType = typeof PORTABLE_OUTPUT_TYPES[number]
export type OutputKind = 'doc' | 'pdf' | 'slides' | 'sheet' | 'csv' | 'email' | 'website' | 'image' | 'video' | 'text' | 'calendar' | 'mailrules' | 'contacts'

export function outputFilename(label: string, extension: string): string {
  return `${(label || 'output').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '').trim().slice(0, 48) || 'output'}.${extension}`
}

export function markdownFileBody(brief: string, input: string, label: string): string {
  const body = brief.includes('{{input}}') ? brief.split('{{input}}').join(input) : [brief && `# ${label}`, input].filter(Boolean).join('\n\n')
  return body.trim() ? body : input || label
}

export type MailRule = { name?: string; from?: string; to?: string; subject?: string; hasWords?: string; label?: string; archive?: boolean; markRead?: boolean; star?: boolean }
export type VcfContact = { name?: string; org?: string; title?: string; email?: string; phone?: string; note?: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function textFields(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (value[field] != null && (typeof value[field] !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value[field] as string))) throw new Error(`Invalid ${field} in generated output.`)
}

/** The browser and scheduled runner produce the same importable filter file. */
export function buildGmailFiltersXml(rules: MailRule[]): Blob {
  if (!Array.isArray(rules) || !rules.length) throw new Error('No inbox rules were provided.')
  const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')
  const entries = rules.map(rule => {
    if (!record(rule)) throw new Error('Invalid inbox rule.')
    textFields(rule, ['name', 'from', 'to', 'subject', 'hasWords', 'label'])
    if (![rule.from, rule.to, rule.subject, rule.hasWords].some(value => typeof value === 'string' && value.trim())) throw new Error('An inbox rule needs a matching condition.')
    for (const field of ['archive', 'markRead', 'star'] as const) if (rule[field] != null && typeof rule[field] !== 'boolean') throw new Error(`Invalid ${field} in inbox rule.`)
    const props = [
      ['from', rule.from], ['to', rule.to], ['subject', rule.subject], ['hasTheWord', rule.hasWords], ['label', rule.label],
      ['shouldArchive', rule.archive ? 'true' : ''], ['shouldMarkAsRead', rule.markRead ? 'true' : ''], ['shouldStar', rule.star ? 'true' : ''],
    ].filter(([, value]) => value).map(([name, value]) => `<apps:property name="${name}" value="${esc(String(value))}"/>`).join('')
    return `<entry><category term="filter"/><title>${esc(String(rule.name || 'Mail Filter'))}</title><content/>${props}</entry>`
  }).join('')
  return new Blob([`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006"><title>Mail Filters</title>${entries}</feed>`], { type: 'text/xml' })
}

// vCard3 uses escaped text and folded content lines (RFC2426 §2.6 / RFC2425 §5.8.1).
// https://www.rfc-editor.org/rfc/rfc2426#section-2.6
function fold(line: string): string {
  const encoder = new TextEncoder(), lines: string[] = []
  let current = '', size = 0
  for (const char of line) {
    const bytes = encoder.encode(char).length
    if (size + bytes > 75) { lines.push(current); current = ' '; size = 1 }
    current += char; size += bytes
  }
  return [...lines, current].join('\r\n')
}

export function buildVcfBlob(contacts: VcfContact[]): Blob {
  if (!Array.isArray(contacts) || !contacts.length) throw new Error('No contacts were provided.')
  const esc = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, '\\$&')
  const cards = contacts.map(contact => {
    if (!record(contact)) throw new Error('Invalid contact.')
    textFields(contact, ['name', 'org', 'title', 'email', 'phone', 'note'])
    if (![contact.name, contact.email, contact.phone].some(value => typeof value === 'string' && value.trim())) throw new Error('A contact needs a name, email or phone number.')
    if (/[\r\n]/.test(String(contact.email || '') + String(contact.phone || ''))) throw new Error('Contact email and phone must each fit on one line.')
    const words = (contact.name || '').trim().split(/\s+/)
    return [
      'BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(contact.name || contact.email || 'Contact')}`,
      `N:${esc(words[words.length - 1] || '')};${esc(words.slice(0, -1).join(' '))};;;`,
      ...(contact.org ? [`ORG:${esc(contact.org)}`] : []), ...(contact.title ? [`TITLE:${esc(contact.title)}`] : []),
      ...(contact.email ? [`EMAIL;TYPE=INTERNET:${esc(contact.email)}`] : []), ...(contact.phone ? [`TEL;TYPE=WORK,VOICE:${esc(contact.phone)}`] : []),
      ...(contact.note ? [`NOTE:${esc(contact.note)}`] : []), 'END:VCARD',
    ].map(fold).join('\r\n')
  })
  return new Blob([cards.join('\r\n') + '\r\n'], { type: 'text/vcard' })
}
