// Pull readable text out of an attached file, client-side. Heavy parsers
// (pdf.js, JSZip) are dynamically imported so they never weigh down the bundle.
// Supports: plain text / markdown / csv / json / code, PDF, and Word .docx.

export type Attachment = {
  id: string
  name: string
  type: string // mime or extension
  size: number
  text: string // extracted text (may be truncated)
  truncated?: boolean
  dataUrl?: string // original file (for open/download); omitted for large files
}

const MAX_KEEP_BYTES = 6 * 1024 * 1024 // keep the original for files up to ~6MB

async function readAsDataUrl(file: File): Promise<string | undefined> {
  if (file.size > MAX_KEEP_BYTES) return undefined
  return new Promise((res) => {
    const fr = new FileReader()
    fr.onload = () => res(typeof fr.result === 'string' ? fr.result : undefined)
    fr.onerror = () => res(undefined)
    fr.readAsDataURL(file)
  })
}

const MAX_CHARS = 30000 // keep prompts sane + within localStorage quota

function clip(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_CHARS) return { text: s, truncated: false }
  return { text: s.slice(0, MAX_CHARS), truncated: true }
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|ts|tsx|jsx|py|java|c|cpp|cs|go|rs|rb|php|sh|sql|ini|conf|log|tex)$/i

async function readAsText(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(typeof fr.result === 'string' ? fr.result : '')
    fr.onerror = () => rej(fr.error)
    fr.readAsText(file)
  })
}

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  // Worker: point at the bundled worker via a URL import (Vite resolves it).
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(pdfjs as any).GlobalWorkerOptions.workerSrc = workerUrl
  const buf = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data: buf }).promise
  const parts: string[] = []
  const max = Math.min(doc.numPages, 100)
  for (let i = 1; i <= max; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const line = content.items.map((it: any) => (typeof it.str === 'string' ? it.str : '')).join(' ')
    parts.push(line)
  }
  return parts.join('\n\n')
}

async function extractDocx(file: File): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const docXml = zip.file('word/document.xml')
  if (!docXml) return ''
  const xml = await docXml.async('string')
  // Paragraphs → newlines; tabs; strip the rest of the XML.
  return xml
    .replace(/<w:p\b[^>]*>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function extractAttachment(file: File): Promise<Attachment> {
  const name = file.name
  const lower = name.toLowerCase()
  let raw = ''
  try {
    if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
      raw = await extractPdf(file)
    } else if (lower.endsWith('.docx')) {
      raw = await extractDocx(file)
    } else if (TEXT_EXT.test(lower) || file.type.startsWith('text/') || file.type === 'application/json') {
      raw = await readAsText(file)
    } else {
      // Last resort — try reading as text; many files are utf-8 underneath.
      raw = await readAsText(file)
    }
  } catch (e) {
    raw = `[Could not read ${name}: ${e instanceof Error ? e.message : 'error'}]`
  }
  const { text, truncated } = clip(raw.trim())
  const dataUrl = await readAsDataUrl(file)
  return {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    name,
    type: file.type || lower.split('.').pop() || 'file',
    size: file.size,
    text,
    truncated,
    dataUrl,
  }
}
