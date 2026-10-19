import type { SwarmStudioKind } from './_swarmGeneration'

export interface SwarmStudioMedia {
  attachmentId: string; filename: string; mime: 'image/png' | 'image/jpeg' | 'video/mp4' | 'video/webm'
  size: number; parts: number; sha256: string
}

export interface SwarmStudioArtifact {
  type: 'studio-artifact'
  studioKind: SwarmStudioKind
  payload: Record<string, unknown>
  /** Source-only CAD and explicitly truncated drafts still need completion. */
  status: 'done' | 'waiting'
  summary: string
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hasText = (value: unknown) => typeof value === 'string' && value.trim().length > 0
const hasList = (value: unknown) => Array.isArray(value) && value.length > 0
const hasMedia = (value: unknown, kind: 'image' | 'video'): boolean => isRecord(value)
  && typeof value.attachmentId === 'string' && /^att_[a-f0-9]{64}$/.test(value.attachmentId)
  && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
  && typeof value.filename === 'string' && value.filename.length > 0 && value.filename.length <= 180
  && (kind === 'image' ? ['image/png', 'image/jpeg'] : ['video/mp4', 'video/webm']).includes(String(value.mime))
  && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= (kind === 'image' ? 2 : 24) * 1024 * 1024
  && value.parts === Math.ceil(value.size / 786432)

/** Response-shape check, not a replacement for a generator's quality/runtime
 * validation. Preserve its complete payload, diagnostics, and editable content. */
export function validateSwarmStudioArtifact(kind: SwarmStudioKind, value: unknown): SwarmStudioArtifact {
  if (!isRecord(value) || value.error) throw new Error('The Studio generator did not return a completed artifact.')
  let valid = false
  switch (kind) {
    case 'document': valid = hasList(value.blocks); break
    case 'slides': valid = hasList(value.slides); break
    case 'spreadsheet': valid = hasList(value.sheets); break
    case 'cad': valid = hasText(value.code); break
    case 'image': case 'video': valid = hasText(value.url) || hasMedia(value.media, kind); break
    case 'email': valid = hasText(value.subject) && hasText(value.body); break
    case 'canvas': valid = isRecord(value.canvas); break
    case 'palette': valid = hasList(value.colors); break
    case 'blueprint': valid = hasList(value.shapes) || hasList(value.floors); break
    case 'logo': valid = hasText(value.mark) || hasText(value.lockup) || hasText(value.initials) || hasList(value.options); break
    case 'shopping': valid = hasList(value.items); break
    case 'carousel': valid = hasList(value.slides) && isRecord(value.theme); break
    case 'brand': valid = hasText(value.html) || isRecord(value.brand); break
    default: valid = hasText(value.html)
  }
  if (!valid) throw new Error('The Studio generator returned no usable artifact. This work was not marked complete.')
  if (kind === 'website' && isRecord(value.quality) && isRecord(value.quality.runtime)
    && ['failed', 'unavailable'].includes(String(value.quality.runtime.status))) throw new Error('The website has not passed its runtime checks.')
  const unfinished = value.truncated === true
  return { type: 'studio-artifact', studioKind: kind, payload: structuredClone(value),
    status: kind === 'cad' || unfinished ? 'waiting' : 'done',
    summary: kind === 'cad' ? 'Model source generated. Open the 3D workspace to compile and verify its geometry.'
      : unfinished ? 'An unfinished draft is saved with this work item. Open it to review or edit its source; completion has not been verified.'
      : 'The generated artifact is saved with this work item.',
  }
}
