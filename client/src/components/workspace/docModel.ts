import type { ChartSpec } from './chartRender'
import type { DesignSpec } from './SlidesCard'

export type DocBlock =
  | { type: 'heading'; level?: number; text?: string }
  | { type: 'paragraph'; text?: string }
  | { type: 'bullets'; items?: string[] }
  | { type: 'table'; columns?: string[]; rows?: string[][] }
  | { type: 'chart'; chart?: ChartSpec }
  // A user-attached image (screenshot/photo) embedded into the doc. `src` is a
  // data URL; `w`/`h` are the natural pixel dims (for correct aspect on export).
  | { type: 'image'; src?: string; caption?: string; w?: number; h?: number }

export type DocSource = { title: string; url: string; accessedAt?: string; publishedAt?: string; modifiedAt?: string; status?: 'read' | 'unavailable' }

export type DocDoc = {
  sources?: DocSource[]
  incompleteSections?: string[]
  checkedAt?: string
  researchStatus?: 'not-needed' | 'verified-sources' | 'unverified'
  title?: string
  subtitle?: string
  cover?: string
  blocks?: DocBlock[]
  design?: DesignSpec
  mediaPreference?: { omitGenerated: boolean; omitAttached: boolean }
}

// The model's JSON is imperfect in the wild: text as nested objects, items as a
// string, rows as objects. NORMALIZE everything up front so the card and the
// Word/PDF exports can never throw ("The document couldn't render here").
function asText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o.text != null) return asText(o.text)
    if (o.value != null) return asText(o.value)
    try { return JSON.stringify(v) } catch { return '' }
  }
  return ''
}
export function normalizeDoc(raw: DocDoc): DocDoc {
  const blocks = (Array.isArray(raw?.blocks) ? raw.blocks : [])
    .filter((b) => b && typeof b === 'object')
    .map((b) => {
      const t = String((b as { type?: unknown }).type || 'paragraph')
      if (t === 'bullets') {
        const it = (b as { items?: unknown }).items
        const items = Array.isArray(it) ? it.map(asText).filter(Boolean) : asText(it).split(/\n+/).filter(Boolean)
        return { type: 'bullets' as const, items }
      }
      if (t === 'table') {
        const rawCols = Array.isArray((b as { columns?: unknown }).columns) ? (b as { columns: unknown[] }).columns : []
        const cols = rawCols.map(asText)
        const keys = rawCols.map(value => typeof value === 'string' ? value : asText(value))
        const rawRows = Array.isArray((b as { rows?: unknown }).rows) ? ((b as { rows: unknown[] }).rows) : []
        // Object property order is not column order. Keep unknown fields too;
        // silently assigning them to unrelated headers changes their meaning.
        for (const row of rawRows) if (row && typeof row === 'object' && !Array.isArray(row)) {
          for (const key of Object.keys(row)) if (!keys.includes(key)) { keys.push(key); cols.push(asText(key)) }
        }
        const width = rawRows.reduce<number>((max, row) => Math.max(max, Array.isArray(row) ? row.length : row && typeof row === 'object' ? keys.length : 1), cols.length)
        while (cols.length < width) { cols.push(`Column ${cols.length + 1}`); keys.push('') }
        const rows = rawRows.map(row => {
          const values = Array.isArray(row) ? row.map(asText) : row && typeof row === 'object'
            ? keys.map(key => Object.prototype.hasOwnProperty.call(row, key) ? asText((row as Record<string, unknown>)[key]) : '')
            : [asText(row)]
          return Array.from({ length: width }, (_, i) => values[i] ?? '')
        })
        return { type: 'table' as const, columns: cols, rows }
      }
      if (t === 'heading') {
        const lv = Number((b as { level?: unknown }).level)
        return { type: 'heading' as const, level: Number.isInteger(lv) && lv >= 1 && lv <= 4 ? lv : 2, text: asText((b as { text?: unknown }).text) }
      }
      if (t === 'chart') return b
      if (t === 'image') {
        const image = b as { src?: unknown; caption?: unknown; w?: unknown; h?: unknown }
        return { type: 'image' as const, src: typeof image.src === 'string' ? image.src : '', caption: asText(image.caption), w: Number.isFinite(Number(image.w)) && Number(image.w) > 0 ? Number(image.w) : undefined, h: Number.isFinite(Number(image.h)) && Number(image.h) > 0 ? Number(image.h) : undefined }
      }
      return { type: 'paragraph' as const, text: asText((b as { text?: unknown }).text ?? b) }
    })
    .filter((b) => (b.type === 'bullets' ? (b.items || []).length : b.type === 'table' ? ((b as { columns?: string[] }).columns || []).length : b.type === 'chart' || b.type === 'image' ? true : ((b as { text?: string }).text || '').trim().length))
  return { ...raw, title: asText(raw?.title), subtitle: asText(raw?.subtitle), cover: asText(raw?.cover) || undefined, blocks: blocks as DocDoc['blocks'] }
}

/** Shared bibliography for preview, Word, and PDF; stored content stays editable. */
export function documentWithSources(raw: DocDoc): DocDoc {
  const doc = normalizeDoc(raw)
  const sources = (Array.isArray(doc.sources) ? doc.sources : []).filter(s => s && s.status !== 'unavailable' && /^https?:\/\//i.test(s.url))
  if (doc.incompleteSections?.length) doc.blocks = [...(doc.blocks || []), { type: 'heading', level: 1, text: 'Incomplete sections' }, { type: 'paragraph', text: 'These sections could not be generated: ' + doc.incompleteSections.join('; ') + '. This document is incomplete.' }]
  if (!sources.length) return doc
  return { ...doc, blocks: [...(doc.blocks || []), { type: 'heading', level: 1, text: 'Sources' }, ...sources.map((s, i): DocBlock => ({ type: 'paragraph', text: `${i + 1}. [${s.title.replace(/[\[\]]/g, '')}](${s.url})${s.publishedAt ? ` · Published ${s.publishedAt}` : ' · Publication date unknown'}${s.modifiedAt ? ` · Updated ${s.modifiedAt}` : ''}${s.accessedAt ? ` · Accessed ${s.accessedAt.slice(0, 10)}` : ''}` }))] }
}
