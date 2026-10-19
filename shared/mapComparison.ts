// A comparison is an evidence table, not an invented 1–10 ranking. The server
// binds every displayed value to text actually read for this request; the
// client sanitizes the same contract again without promoting old score cards.
export type MapEvidence = { url: string; text: string; accessedAt?: string; publishedAt?: string }
export type MapMetric = { value: string | null; sourceUrl?: string; quote?: string; accessedAt?: string; publishedAt?: string; status: 'sourced' | 'unavailable' }
export type MapComparison = { title: string; criteria: string[]; places: Array<{ name: string; lat: number; lng: number; metrics: Record<string, MapMetric>; note: string }>; methodology: string }
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const text = (v: unknown, limit: number) => typeof v === 'string' ? v.trim().slice(0, limit) : ''
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
function sourceUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && u.hostname ? u.href : null } catch { return null }
}
function metric(raw: unknown, evidence?: MapEvidence[]): MapMetric {
  const m = record(raw), missing: MapMetric = { value: null, status: 'unavailable' }
  if (!m) return missing
  const value = typeof m.value === 'number' && Number.isFinite(m.value) ? String(m.value) : text(m.value, 100)
  const url = sourceUrl(m.sourceUrl), quote = text(m.quote, 600)
  if (!value || !url || quote.length < 12) return missing
  // A number/name must occur in its exact supporting passage. This is an
  // extraction check, not a claim of source accuracy or semantic entailment.
  const literal = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const before = /^\d/.test(value) ? '[^\\p{L}\\p{N}.,]' : '[^\\p{L}\\p{N}]'
  const after = /\d$/.test(value) ? '[^\\p{L}\\p{N}.,]' : '[^\\p{L}\\p{N}]'
  if (!new RegExp(`(?:^|${before})${literal}(?:$|${after})`, 'u').test(normalize(quote))) return missing
  if (evidence) {
    const source = evidence.find((s) => sourceUrl(s.url) === url && normalize(s.text).includes(normalize(quote)))
    if (!source) return missing
    return { value, sourceUrl: url, quote, status: 'sourced', ...(source.accessedAt ? { accessedAt: source.accessedAt } : {}), ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}) }
  }
  // Client accepts only the server's explicit sourced state. Legacy score-only
  // responses cannot acquire provenance merely by being rendered again.
  if (m.status !== 'sourced') return missing
  return { value, sourceUrl: url, quote, status: 'sourced', ...(typeof m.accessedAt === 'string' ? { accessedAt: m.accessedAt.slice(0, 40) } : {}), ...(typeof m.publishedAt === 'string' ? { publishedAt: m.publishedAt.slice(0, 40) } : {}) }
}
export function normalizeMapComparison(raw: unknown, evidence?: MapEvidence[]): MapComparison | null {
  const data = record(raw)
  if (!data || !Array.isArray(data.criteria) || !Array.isArray(data.places)) return null
  const criteria = [...new Set(data.criteria.map((c) => text(c, 60)).filter(Boolean))].slice(0, 6)
  const used = new Set<string>()
  const places = data.places.flatMap((rawPlace) => {
    const p = record(rawPlace)
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return []
    const name = text(p.name, 80)
    if (!name || used.has(name.toLowerCase())) return []
    used.add(name.toLowerCase())
    const metrics = record(p.metrics) || {}
    return [{ name, lat: p.lat, lng: p.lng, metrics: Object.fromEntries(criteria.map((c) => [c, metric(metrics[c], evidence)])), note: text(p.note, 300) }]
  }).slice(0, 6)
  if (!criteria.length || places.length < 2) return null
  return { title: text(data.title, 120) || 'Place comparison', criteria, places, methodology: 'Values are extracted from the linked sources. Missing evidence remains unavailable. Criteria have no automatic weights, total score, or overall winner.' }
}

// ResearchBrief intentionally excludes page bodies in its public sources list.
// Extract only the matching source-evidence block from the exact brief supplied
// to the model, excluding search leads and linked-but-unread pages.
export function mapComparisonEvidence(brief: { text: string; sources?: Array<{ url: string; status?: string; accessedAt?: string; publishedAt?: string }> }): MapEvidence[] {
  const text = brief.text.split('SEARCH LEADS ONLY')[0]
  const blocks = text.split(/\n\n———\n\n/)
  return (brief.sources || []).flatMap((source) => {
    if (source.status !== 'read') return []
    const marker = `\n${source.url}\nAccessed:`, block = blocks.find((part) => part.includes(marker))
    if (!block) return []
    const start = block.indexOf('\n', block.indexOf(marker) + marker.length)
    return start >= 0 ? [{ ...source, text: block.slice(start + 1) }] : []
  })
}
