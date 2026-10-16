// Photoreal cover/section images for decks & docs — no API key (Pollinations).
// Each call races a timeout so a slow/failed image never blocks a download; on
// failure the caller falls back to a solid brand-color cover.

/** The raw generated-photo URL — usable directly as an <img src> for live
 *  previews (the browser streams it; pair with onError for a graceful hide). */
export function coverImageUrl(desc: string, w: number, h: number): string {
  const prompt = `professional cinematic photograph, ${desc}, elegant, premium, refined, natural light, high detail, no text, no watermark`
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&model=flux`
}
const url = coverImageUrl

async function fetchBlob(desc: string, w: number, h: number, timeoutMs: number): Promise<Blob | null> {
  if (!desc || !desc.trim()) return null
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url(desc, w, h), { signal: ctrl.signal })
    if (!r.ok) return null
    const blob = await r.blob()
    return blob.size > 1000 && blob.type.startsWith('image/') ? blob : null
  } catch {
    return null
  } finally { clearTimeout(t) }
}

/** Data URL (data:image/...;base64,...) — for pptxgenjs addImage + jsPDF addImage. */
export async function coverImageDataUrl(desc: string, w = 1600, h = 900, timeoutMs = 18000): Promise<string | null> {
  const blob = await fetchBlob(desc, w, h, timeoutMs)
  if (!blob) return null
  return new Promise((res) => {
    const fr = new FileReader()
    fr.onloadend = () => res(typeof fr.result === 'string' ? fr.result : null)
    fr.onerror = () => res(null)
    fr.readAsDataURL(blob)
  })
}

/** ArrayBuffer — for docx ImageRun. */
export async function coverImageBuffer(desc: string, w = 1600, h = 900, timeoutMs = 18000): Promise<ArrayBuffer | null> {
  const blob = await fetchBlob(desc, w, h, timeoutMs)
  if (!blob) return null
  try {
    return await blob.arrayBuffer()
  } catch {
    return null
  }
}
