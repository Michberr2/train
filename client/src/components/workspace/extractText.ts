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
  isImage?: boolean // screenshot/photo — sent to the vision model + embeddable in docs
  storage?: { id: string; parts: number; mime: string; size: number; sha256: string }
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
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i

// Downscale a screenshot/photo to a model- and storage-friendly size: vision
// models cap resolution anyway, and chats persist to localStorage (a few MB
// total), so a 6MB retina PNG must shrink to a small JPEG dataUrl before we keep
// it. Returns a data:image/jpeg;base64 URL (or the raw dataUrl on any failure).
async function downscaleImage(file: File, maxDim = 1568): Promise<string | undefined> {
  try {
    const url = await new Promise<string>((res, rej) => {
      const fr = new FileReader()
      fr.onload = () => res(String(fr.result || ''))
      fr.onerror = () => rej(fr.error)
      fr.readAsDataURL(file)
    })
    if (!url) return undefined
    // SVG has no intrinsic raster size — keep it as-is (it's already tiny text).
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return url
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image()
      im.onload = () => res(im)
      im.onerror = () => rej(new Error('decode failed'))
      im.src = url
    })
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    if (scale === 1 && /^image\/(png|jpeg|webp)$/i.test(file.type)) return url
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return url
    ctx.drawImage(img, 0, 0, w, h)
    // Keep alpha for transparent headshots / cutouts instead of flattening them
    // onto JPEG's black background.
    return canvas.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', 0.9)
  } catch {
    return undefined
  }
}

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

  // Images (screenshots, photos): no text to extract — keep a downscaled dataUrl
  // that we hand to the vision model and can embed into generated docs/slides.
  if (file.type.startsWith('image/') || IMAGE_EXT.test(lower)) {
    const dataUrl = await downscaleImage(file)
    return {
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      name,
      type: file.type || lower.split('.').pop() || 'image',
      size: file.size,
      text: '',
      isImage: true,
      dataUrl,
    }
  }

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
