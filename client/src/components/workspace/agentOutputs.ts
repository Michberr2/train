// Agent pipeline outputs — files a flow produced (documents, decks, workbooks,
// emails). Every output AUTO-DOWNLOADS to the browser's Downloads folder AND is
// stored in the system (IndexedDB) so the Outputs library can re-download it
// any time. Metadata mirrors to localStorage for instant listing.

export type OutputMeta = {
  id: string
  flowId: string
  flowName: string
  nodeLabel: string
  kind: 'doc' | 'pdf' | 'slides' | 'sheet' | 'csv' | 'email' | 'website' | 'image' | 'video' | 'text' | 'calendar' | 'mailrules' | 'contacts'
  filename: string
  size: number
  ts: number
}

const DB_NAME = 'nalu-agent-outputs'
const STORE = 'files'
const META_KEY = 'nalu-agent-output-meta'
const MAX_OUTPUTS = 60

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function listOutputs(): OutputMeta[] {
  try {
    const arr = JSON.parse(localStorage.getItem(META_KEY) || '[]') as OutputMeta[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function saveMeta(metas: OutputMeta[]) {
  try { localStorage.setItem(META_KEY, JSON.stringify(metas.slice(0, MAX_OUTPUTS))) } catch { /* quota */ }
}

/** Persist an output file to the system (IndexedDB + meta index). Best-effort. */
export async function storeOutput(meta: OutputMeta, blob: Blob): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ id: meta.id, blob })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    const metas = [meta, ...listOutputs().filter((m) => m.id !== meta.id)]
    // prune both stores past the cap
    const keep = metas.slice(0, MAX_OUTPUTS)
    saveMeta(keep)
    const dead = metas.slice(MAX_OUTPUTS)
    if (dead.length) {
      const tx = db.transaction(STORE, 'readwrite')
      for (const d of dead) tx.objectStore(STORE).delete(d.id)
    }
    db.close()
  } catch {
    /* storage unavailable — the auto-download still happened */
  }
}

export async function getOutputBlob(id: string): Promise<Blob | null> {
  try {
    const db = await openDb()
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(id)
      req.onsuccess = () => resolve((req.result as { blob?: Blob } | undefined)?.blob || null)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return blob
  } catch {
    return null
  }
}

export async function deleteOutput(id: string): Promise<void> {
  saveMeta(listOutputs().filter((m) => m.id !== id))
  try {
    const db = await openDb()
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)
    db.close()
  } catch { /* */ }
}

/** Trigger a browser download (lands in the user's Downloads folder). */
export function downloadBlobFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

/** Build a standards-compliant .eml draft (opens in Mail/Outlook when double-clicked). */
export function buildEmlBlob(to: string, subject: string, body: string): Blob {
  const eml = [
    `To: ${to || ''}`,
    `Subject: ${subject || 'From Nalu Agents'}`,
    'X-Unsent: 1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')
  return new Blob([eml], { type: 'message/rfc822' })
}

// ---- real-world work artifacts ----------------------------------------------

export type IcsEvent = { title?: string; start?: string; end?: string; location?: string; description?: string; attendees?: string[] }

/** Build an RFC-5545 .ics file — meetings/reservations import straight into
 *  Outlook, Google Calendar, and Apple Calendar (double-click adds them). */
export function buildIcsBlob(events: IcsEvent[]): Blob {
  const dt = (s?: string) => (s || '').replace(/[-:]/g, '').replace(/\.\d+.*$/, '').slice(0, 15)
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, ' ').replace(/\n/g, '\\n')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nalu//Employees//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events.flatMap((e, i) => {
      const start = dt(e.start)
      if (!start) return []
      return [
        'BEGIN:VEVENT',
        `UID:nalu-${Date.now()}-${i}@n4lu.ai`,
        `DTSTAMP:${dt(new Date().toISOString())}Z`,
        `DTSTART:${start}`,
        `DTEND:${dt(e.end) || start}`,
        `SUMMARY:${esc(e.title || 'Meeting')}`,
        ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
        ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
        ...(e.attendees || []).filter(Boolean).map((a) => `ATTENDEE;CN=${esc(a)};RSVP=TRUE:mailto:${a}`),
        'END:VEVENT',
      ]
    }),
    'END:VCALENDAR',
  ]
  return new Blob([lines.join('\r\n')], { type: 'text/calendar' })
}

export type MailRule = { name?: string; from?: string; to?: string; subject?: string; hasWords?: string; label?: string; archive?: boolean; markRead?: boolean; star?: boolean }

/** Build a Gmail filters .xml — imports via Gmail Settings → Filters → Import.
 *  (Outlook equivalents are described in the accompanying text output.) */
export function buildGmailFiltersXml(rules: MailRule[]): Blob {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const entries = rules
    .filter((r) => r.from || r.to || r.subject || r.hasWords)
    .map((r) => {
      const props = [
        r.from ? `<apps:property name="from" value="${esc(r.from)}"/>` : '',
        r.to ? `<apps:property name="to" value="${esc(r.to)}"/>` : '',
        r.subject ? `<apps:property name="subject" value="${esc(r.subject)}"/>` : '',
        r.hasWords ? `<apps:property name="hasTheWord" value="${esc(r.hasWords)}"/>` : '',
        r.label ? `<apps:property name="label" value="${esc(r.label)}"/>` : '',
        r.archive ? '<apps:property name="shouldArchive" value="true"/>' : '',
        r.markRead ? '<apps:property name="shouldMarkAsRead" value="true"/>' : '',
        r.star ? '<apps:property name="shouldStar" value="true"/>' : '',
      ].filter(Boolean).join('')
      return `<entry><category term="filter"/><title>${esc(r.name || 'Mail Filter')}</title><content/>${props}</entry>`
    })
    .join('')
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006"><title>Mail Filters</title>${entries}</feed>`
  return new Blob([xml], { type: 'text/xml' })
}

export type VcfContact = { name?: string; org?: string; title?: string; email?: string; phone?: string; note?: string }

/** Build a vCard 3.0 .vcf — contacts import straight into Apple/Google/Outlook. */
export function buildVcfBlob(contacts: VcfContact[]): Blob {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, '\\$&').replace(/\n/g, '\\n')
  const cards = contacts
    .filter((c) => c.name || c.email || c.phone)
    .map((c) => [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${esc(c.name || c.email || 'Contact')}`,
      `N:${esc((c.name || '').split(' ').slice(-1)[0] || '')};${esc((c.name || '').split(' ').slice(0, -1).join(' '))};;;`,
      ...(c.org ? [`ORG:${esc(c.org)}`] : []),
      ...(c.title ? [`TITLE:${esc(c.title)}`] : []),
      ...(c.email ? [`EMAIL;TYPE=INTERNET:${c.email}`] : []),
      ...(c.phone ? [`TEL;TYPE=WORK,VOICE:${c.phone}`] : []),
      ...(c.note ? [`NOTE:${esc(c.note)}`] : []),
      'END:VCARD',
    ].join('\r\n'))
  return new Blob([cards.join('\r\n') + '\r\n'], { type: 'text/vcard' })
}

/** Open the user's mail client with a prefilled draft (body truncated to URL limits). */
export function openMailto(to: string, subject: string, body: string) {
  const url = `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(body.slice(0, 1800))}`
  window.open(url, '_self')
}
