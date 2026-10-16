import JSZip from 'jszip'
import { loadSlideFont, SLIDE_FONT_CATALOG, type SlideFontStyle } from './slideFonts'

const STYLES: SlideFontStyle[] = ['normal', 'bold', 'italic', 'bolditalic']
const ELEMENTS = ['regular', 'bold', 'italic', 'boldItalic']
const xmlText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/** PowerPoint uses Embedded OpenType font parts, not Word's obfuscated fonts.
 * Uncompressed EOT 0x00020001: https://www.w3.org/submissions/EOT/
 * The complete licensed TTF remains byte-for-byte intact inside the wrapper. */
export function powerpointFontData(bytes: Uint8Array): { family: string; data: Uint8Array } {
  const invalid = () => new Error('A bundled presentation font is invalid and could not be embedded.')
  if (bytes.length < 100 || bytes.length > 8 * 1024 * 1024) throw invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== 0x00010000) throw invalid()
  const count = view.getUint16(4)
  if (12 + count * 16 > bytes.length) throw invalid()
  const tables = new Map<string, { offset: number; length: number }>()
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16
    const tag = String.fromCharCode(...bytes.subarray(p, p + 4))
    const offset = view.getUint32(p + 8), length = view.getUint32(p + 12)
    if (offset > bytes.length || length > bytes.length - offset || tables.has(tag)) throw invalid()
    tables.set(tag, { offset, length })
  }
  const table = (tag: string, minimum: number) => {
    const result = tables.get(tag)
    if (!result || result.length < minimum) throw invalid()
    return result
  }
  const os = table('OS/2', 78), head = table('head', 54), names = table('name', 6)
  table('glyf', 1) // Only the bundled static TrueType outline fonts are supported.
  const fsType = view.getUint16(os.offset + 8)
  if (fsType & 0x200 || fsType & 0x2 || (fsType & 0x4 && !(fsType & 0x8))) throw new Error('This presentation font does not permit editable embedding.')
  const nameCount = view.getUint16(names.offset + 2), storage = view.getUint16(names.offset + 4)
  if (6 + nameCount * 12 > names.length || storage > names.length) throw invalid()
  const english = new Map<number, string>()
  for (let i = 0; i < nameCount; i++) {
    const p = names.offset + 6 + i * 12
    // The catalog contains Windows Unicode English naming records; these are
    // the precise family/style names required by Microsoft's EOT format.
    if (view.getUint16(p) !== 3 || view.getUint16(p + 4) !== 0x409) continue
    const id = view.getUint16(p + 6), length = view.getUint16(p + 8), offset = storage + view.getUint16(p + 10)
    if (length % 2 || offset > names.length || length > names.length - offset) throw invalid()
    let text = ''
    for (let j = 0; j < length; j += 2) text += String.fromCharCode(view.getUint16(names.offset + offset + j))
    if (!english.has(id)) english.set(id, text)
  }
  const strings = [1, 2, 5, 4].map(id => english.get(id))
  if (strings.some(value => !value || value.length * 2 > 65535)) throw invalid()
  const values = strings as string[]
  const headerSize = 100 + values.reduce((sum, text) => sum + text.length * 2, 0)
  const data = new Uint8Array(headerSize + bytes.length), out = new DataView(data.buffer)
  out.setUint32(0, data.length, true)
  out.setUint32(4, bytes.length, true)
  out.setUint32(8, 0x00020001, true)
  // Flags/reserved/padding/root string remain zero: no compression, XOR,
  // subsetting, or domain restriction. Preserve the source embedding rights.
  data.set(bytes.subarray(os.offset + 32, os.offset + 42), 16)
  data[26] = 1 // DEFAULT_CHARSET
  data[27] = view.getUint16(os.offset + 62) & 1
  out.setUint32(28, view.getUint16(os.offset + 4), true)
  out.setUint16(32, fsType, true)
  out.setUint16(34, 0x504c, true)
  for (let i = 0; i < 4; i++) out.setUint32(36 + i * 4, view.getUint32(os.offset + 42 + i * 4), true)
  if (os.length >= 86 && view.getUint16(os.offset) >= 1) for (let i = 0; i < 2; i++) out.setUint32(52 + i * 4, view.getUint32(os.offset + 78 + i * 4), true)
  out.setUint32(60, view.getUint32(head.offset + 8), true)
  let p = 82
  for (const text of values) {
    out.setUint16(p, text.length * 2, true); p += 2
    for (let i = 0; i < text.length; i++) { out.setUint16(p, text.charCodeAt(i), true); p += 2 }
    p += 2
  }
  p += 2
  data.set(bytes, p)
  return { family: values[0], data }
}

/** Add font parts to our generated PPTX only. Use all four licensed styles of
 * each used family so editing the deck does not require a system font install.
 * Unsupported/custom names remain untouched and are never relabeled. */
export async function embedPowerpointFonts(blob: Blob, requestedFamilies: string[]): Promise<Blob> {
  const families = [...new Set(requestedFamilies)].filter(family => Object.prototype.hasOwnProperty.call(SLIDE_FONT_CATALOG, family))
  if (!families.length) return blob
  const embedded = await Promise.all(families.map(async family => ({ family, styles: await Promise.all(STYLES.map(async style => {
    const font = powerpointFontData(await loadSlideFont(family, style))
    if (font.family !== family) throw new Error(`The bundled ${family} font has an unexpected family name.`)
    return font.data
  })) })))
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const presentation = zip.file('ppt/presentation.xml'), relationships = zip.file('ppt/_rels/presentation.xml.rels'), contentTypes = zip.file('[Content_Types].xml')
  if (!presentation || !relationships || !contentTypes) throw new Error('The PowerPoint package could not be prepared for font embedding.')
  let xml = await presentation.async('string'), rels = await relationships.async('string'), types = await contentTypes.async('string')
  if (/<p:embeddedFontLst\b/.test(xml)) throw new Error('The generated PowerPoint already contains embedded fonts.')
  let nextId = Math.max(0, ...[...rels.matchAll(/\bId="rId(\d+)"/g)].map(match => Number(match[1]))) + 1
  let entries = ''
  for (const { family, styles } of embedded) {
    entries += `<p:embeddedFont><p:font typeface="${xmlText(family)}"/>`
    for (const [index, data] of styles.entries()) {
      const id = `rId${nextId++}`, path = `fonts/${id}.fntdata`
      zip.file(`ppt/${path}`, data)
      rels = rels.replace('</Relationships>', `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="${path}"/></Relationships>`)
      entries += `<p:${ELEMENTS[index]} r:id="${id}"/>`
    }
    entries += '</p:embeddedFont>'
  }
  // PptxGenJS already emits saveSubsetFonts; replace rather than duplicate it.
  xml = xml.replace(/<p:presentation\b[^>]*>/, tag => tag.replace(/\s(?:embedTrueTypeFonts|saveSubsetFonts)="[^"]*"/g, '').replace('>', ' embedTrueTypeFonts="1" saveSubsetFonts="0">'))
  const insertion = /<p:(?:custShowLst|photoAlbum|custDataLst|kinsoku|defaultTextStyle|modifyVerifier|extLst)\b|<\/p:presentation>/.exec(xml)
  if (!insertion || insertion.index === undefined) throw new Error('The PowerPoint font list could not be placed.')
  xml = xml.slice(0, insertion.index) + `<p:embeddedFontLst>${entries}</p:embeddedFontLst>` + xml.slice(insertion.index)
  if (!/Extension="fntdata"/.test(types)) types = types.replace('</Types>', '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>')
  zip.file('ppt/presentation.xml', xml)
  zip.file('ppt/_rels/presentation.xml.rels', rels)
  zip.file('[Content_Types].xml', types)
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}
