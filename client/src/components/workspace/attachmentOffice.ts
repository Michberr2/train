// Bounded OOXML extraction. No macros, external relationships, XML entities or
// embedded scripts execute. Shared by XLSX, PPTX and DOCX attachment readers.
export const OFFICE_LIMITS = { entries: 2000, entryBytes: 8 * 1024 * 1024, expandedBytes: 48 * 1024 * 1024, cells: 20000, pages: 100, chars: 30000 }
export type ExtractedOffice = { text: string; processed: number; total: number; unit: 'sheets' | 'slides' | 'sections'; partial: boolean; hasText: boolean; notes: string[] }
export type OfficeRange = { start?: number; end?: number }
interface ZipByteStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): ZipByteStream
  on(event: 'error', callback: (error: Error) => void): ZipByteStream
  on(event: 'end', callback: () => void): ZipByteStream
  pause(): ZipByteStream
  resume(): ZipByteStream
}
const failure = (message: string): never => { throw new Error(message) }
function preflightZip(buffer: ArrayBuffer) {
  const view = new DataView(buffer), size = view.byteLength
  let end = -1
  for (let i = size - 22; i >= Math.max(0, size - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === size) { end = i; break }
  if (end < 0) failure('This file is not a supported Office ZIP archive.')
  const count = view.getUint16(end + 10, true), length = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) || count === 65535 || start === 0xffffffff || length === 0xffffffff) failure('Split or ZIP64 Office archives are not supported. Export a smaller file.')
  if (count > OFFICE_LIMITS.entries || start + length > end) failure('Office archive exceeds entry limits or has an invalid directory.')
  let position = start, total = 0
  for (let i = 0; i < count; i++) {
    if (position + 46 > start + length || view.getUint32(position, true) !== 0x02014b50) failure('Office archive directory is invalid.')
    const flags = view.getUint16(position + 8, true), bytes = view.getUint32(position + 24, true)
    if (flags & 1) failure('This archive is encrypted. Upload an unencrypted export.')
    if (bytes > OFFICE_LIMITS.entryBytes) failure('An Office archive part exceeds the 8 MB extraction limit. Split the file or export the needed range.')
    total += bytes
    if (total > OFFICE_LIMITS.expandedBytes) failure('Office archive expands beyond the 48 MB extraction limit.')
    position += 46 + view.getUint16(position + 28, true) + view.getUint16(position + 30, true) + view.getUint16(position + 32, true)
  }
  if (position !== start + length) failure('Office archive directory length is inconsistent.')
}
const nodes = (node: Document | Element, local: string) => node.getElementsByTagNameNS('*', local)
const first = (node: Document | Element, local: string) => nodes(node, local)[0]
const plain = (node: Document | Element, local = 't') => Array.from(nodes(node, local)).map(n => n.textContent || '').join('')
function xml(source: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) failure('XML declarations with custom entities are unsupported.')
  const parsed = new DOMParser().parseFromString(source, 'application/xml')
  if (parsed.getElementsByTagName('*').length > 250000) failure('Office XML exceeds the element limit. Export a smaller range.')
  if (parsed.getElementsByTagName('parsererror').length) failure('An Office XML part is malformed.')
  return parsed
}
function target(base: string, relative: string): string {
  if (/^[a-z][\w+.-]*:/i.test(relative) || /[\\\u0000]/.test(relative)) return failure('External or invalid Office relationship.')
  const parts = (relative.startsWith('/') ? relative.slice(1) : base.slice(0, base.lastIndexOf('/') + 1) + relative).split('/')
  const safe: string[] = []
  for (const part of parts) { if (part === '..') { if (!safe.length) return failure('Office relationship escapes the archive.'); safe.pop() } else if (part && part !== '.') safe.push(part) }
  return safe.join('/')
}
const relationshipsPath = (path: string) => path.slice(0, path.lastIndexOf('/') + 1) + '_rels/' + path.slice(path.lastIndexOf('/') + 1) + '.rels'
export async function extractOffice(buffer: ArrayBuffer, kind: 'xlsx' | 'pptx' | 'docx', range: OfficeRange = {}): Promise<ExtractedOffice> {
  preflightZip(buffer)
  const JSZip = (await import('jszip')).default, zip = await JSZip.loadAsync(buffer, { createFolders: false })
  let actualBytes = 0
  const deadline = Date.now() + 25000
  const read = async (path: string, required = true): Promise<Document | null> => {
    if (Date.now() >= deadline) failure('Office extraction timed out. Split the file or choose a smaller range.')
    const entry = zip.file(path)
    if (!entry) { if (required) failure(`Required Office part is missing: ${path}`); return null }
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      // JSZip exposes internalStream at runtime but omits it from JSZipObject's
      // declarations. Streaming lets us stop a forged-size archive before a full
      // async('string') allocation, rather than trusting its directory sizes.
      const stream = (entry as unknown as { internalStream(type: 'uint8array'): ZipByteStream }).internalStream('uint8array'), chunks: Uint8Array[] = []; let length = 0, ended = false
      const timer = setTimeout(() => { ended = true; stream.pause(); reject(new Error('Office part extraction timed out.')) }, Math.max(1, Math.min(10000, deadline - Date.now())))
      stream.on('data', chunk => {
        if (ended) return
        length += chunk.length; actualBytes += chunk.length
        if (length > OFFICE_LIMITS.entryBytes || actualBytes > OFFICE_LIMITS.expandedBytes) { ended = true; clearTimeout(timer); stream.pause(); reject(new Error('Office decompression exceeded its safe size limit.')); return }
        chunks.push(chunk)
      }).on('error', error => { if (!ended) { ended = true; clearTimeout(timer); reject(error) } }).on('end', () => {
        if (ended) return
        ended = true; clearTimeout(timer); const joined = new Uint8Array(length); let offset = 0
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
        resolve(joined)
      }).resume()
    })
    return xml(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  const relations = async (path: string) => {
    const document = await read(relationshipsPath(path), false), map = new Map<string, { path: string; type: string }>()
    if (document) for (const relation of Array.from(nodes(document, 'Relationship'))) {
      if (relation.getAttribute('TargetMode') === 'External') continue
      const id = relation.getAttribute('Id'), destination = relation.getAttribute('Target')
      if (id && destination) map.set(id, { path: target(path, destination), type: relation.getAttribute('Type') || '' })
    }
    return map
  }
  const sections: string[] = [], notes: string[] = []; let size = 0, partial = false, hasText = false, processed = 0, total = 0
  const add = (label: string, content: string) => {
    hasText ||= !!content.trim()
    const piece = `[${label}]\n${content.trim()}\n\n`, remaining = OFFICE_LIMITS.chars - size
    if (piece.length > remaining) { sections.push(piece.slice(0, Math.max(0, remaining))); size = OFFICE_LIMITS.chars; partial = true; return false }
    sections.push(piece); size += piece.length; return true
  }
  const selected = (index: number) => index >= (range.start || 1) && index <= (range.end || Infinity)
  if (kind === 'xlsx') {
    const workbook = (await read('xl/workbook.xml'))!, links = await relations('xl/workbook.xml')
    const stringsXml = await read('xl/sharedStrings.xml', false), shared = stringsXml ? Array.from(nodes(stringsXml, 'si')).map(n => plain(n)) : []
    const styles = await read('xl/styles.xml', false), custom = new Map<string, string>()
    if (styles) for (const format of Array.from(nodes(styles, 'numFmt'))) custom.set(format.getAttribute('numFmtId') || '', format.getAttribute('formatCode') || '')
    const styleIds = styles ? Array.from(first(styles, 'cellXfs')?.children || []).map(n => n.getAttribute('numFmtId') || '0') : []
    const formats: Record<string, string> = { '9': '0%', '10': '0.00%', '14': 'date', '15': 'date', '16': 'date', '17': 'date', '18': 'time', '19': 'time', '20': 'time', '21': 'time', '22': 'date/time', '45': 'time', '46': 'elapsed time', '47': 'time' }
    const tabs = nodes(workbook, 'sheet'); total = tabs.length; let cells = 0
    if (!total || (range.start || 1) > total) failure('The workbook has no sheets in the requested range.')
    notes.push('Spreadsheet formulas are not recalculated. Cached formula values may be stale. Numeric cells are raw values; relevant number formats are shown. Images, charts and formatting are not interpreted.')
    for (let i = 0; i < tabs.length; i++) {
      if (!selected(i + 1)) { partial = true; continue }
      if (processed >= OFFICE_LIMITS.pages || size >= OFFICE_LIMITS.chars || cells >= OFFICE_LIMITS.cells) { partial = true; break }
      const tab = tabs[i], link = links.get(tab.getAttribute('r:id') || tab.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || '')
      if (!link) return failure('A workbook sheet relationship is missing.')
      const doc = (await read(link.path))!, lines: string[] = []; let sectionChars = 0
      for (const row of Array.from(nodes(doc, 'row'))) {
        const parts: string[] = []
        for (const cell of Array.from(row.children).filter(n => n.localName === 'c')) {
          if (++cells > OFFICE_LIMITS.cells) { partial = true; break }
          const type = cell.getAttribute('t'), raw = first(cell, 'v')?.textContent || '', f = first(cell, 'f')
          if (type === 's' && (!/^\d+$/.test(raw) || shared[Number(raw)] === undefined)) return failure('A worksheet references a missing shared string.')
          let value = type === 's' ? shared[Number(raw)] : type === 'inlineStr' ? plain(cell) : type === 'b' ? raw === '1' ? 'TRUE' : 'FALSE' : raw
          const formatId = styleIds[Number(cell.getAttribute('s') || '0')], format = custom.get(formatId) || formats[formatId]
          if (f) value = `${f.textContent ? '=' + f.textContent : '[shared/array formula]'} [${raw ? `cached value: ${value}; freshness unknown` : 'no cached result'}]`
          if (format && value) value += ` [number format: ${format}${/date|time/i.test(format) ? `; ${first(workbook, 'workbookPr')?.getAttribute('date1904') === '1' ? '1904' : '1900'} date system` : ''}]`
          parts.push(`${cell.getAttribute('r') || '?'}=${value}`)
        }
        if (parts.length) { const line = (row.getAttribute('hidden') === '1' ? '[hidden row] ' : '') + parts.join('\t'); lines.push(line); sectionChars += line.length + 1 }
        if (cells >= OFFICE_LIMITS.cells || size + sectionChars >= OFFICE_LIMITS.chars) { partial = true; break }
      }
      processed++
      if (!add(`Worksheet ${i + 1}: ${tab.getAttribute('name') || 'Unnamed'}${tab.getAttribute('state') && tab.getAttribute('state') !== 'visible' ? ' (hidden)' : ''}`, lines.join('\n'))) break
    }
  } else if (kind === 'pptx') {
    const presentation = (await read('ppt/presentation.xml'))!, links = await relations('ppt/presentation.xml'), slides = nodes(presentation, 'sldId'); total = slides.length
    if (!total || (range.start || 1) > total) failure('The presentation has no slides in the requested range.')
    notes.push('Slide text, tables, speaker notes and cached chart values are extracted. Images, diagrams, animations and visual reading order are not interpreted; chart caches may be stale.')
    for (let i = 0; i < slides.length; i++) {
      if (!selected(i + 1)) { partial = true; continue }
      if (processed >= OFFICE_LIMITS.pages || size >= OFFICE_LIMITS.chars) { partial = true; break }
      const link = links.get(slides[i].getAttribute('r:id') || '')
      if (!link) return failure('A presentation slide relationship is missing.')
      const slide = (await read(link.path))!, children = await relations(link.path)
      const content = Array.from(nodes(slide, 'p')).map(n => plain(n)).filter(Boolean)
      for (const child of children.values()) {
        if (!/\/(?:notesSlide|chart)$/.test(child.type)) continue
        const data = await read(child.path)
        if (data) {
          const isNotes = child.type.endsWith('/notesSlide'), text = isNotes ? Array.from(nodes(data, 'p')).map(n => plain(n)).filter(Boolean).join('\n') : Array.from(nodes(data, 'v')).map(n => n.textContent || '').join('\t')
          if (text.trim()) content.push(`${isNotes ? '[Speaker notes]' : '[Chart cached text/data]'}\n${text}`)
        }
      }
      processed++
      if (!add(`Slide ${i + 1}`, content.join('\n'))) break
    }
  } else {
    const mainPath = 'word/document.xml', main = (await read(mainPath))!, links = await relations(mainPath)
    const paths = [{ label: 'Document body', doc: main }]
    for (const child of links.values()) if (/\/(?:header|footer|footnotes|endnotes)$/.test(child.type)) {
      const doc = await read(child.path); if (doc) paths.push({ label: child.type.split('/').pop() || 'Document section', doc })
    }
    total = paths.length
    notes.push('Document body, tables and linked headers/footers/footnotes/endnotes are extracted. Images, layout, comments and revision history are not interpreted.')
    for (const { label, doc } of paths) {
      const lines: string[] = []
      for (const paragraph of Array.from(nodes(doc, 'p'))) {
        let line = ''
        for (const child of Array.from(paragraph.getElementsByTagName('*'))) {
          if (child.localName === 't') line += child.textContent || ''
          else if (child.localName === 'tab') line += '\t'
          else if (child.localName === 'br') line += '\n'
        }
        // Cell labels keep text from adjacent table columns distinguishable.
        if (paragraph.parentElement?.localName === 'tc') line = '[Table cell] ' + line
        lines.push(line)
      }
      processed++; if (!add(label, lines.join('\n'))) break
    }
  }
  if (partial || processed < total) notes.push('Only the reported sections/range fit the extraction limits. Request a smaller page/sheet/slide range or split the file to read the remainder.')
  return { text: sections.join('').trim(), processed, total, hasText, unit: kind === 'xlsx' ? 'sheets' : kind === 'pptx' ? 'slides' : 'sections', partial: partial || processed < total, notes }
}
