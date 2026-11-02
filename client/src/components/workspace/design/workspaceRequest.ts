import { fallbackStudioIntent } from '../../../../../shared/studioIntent'
import type { WorkspaceCarouselView } from '../../workspace-preview/real/WorkspaceCarousel'

/** Keywords choose a real workspace, never certify that work has completed. */
export function workspaceForRequest(text: string): { view: WorkspaceCarouselView; studioKind?: string; query?: string } | null {
  if (/^\s*(?:cancel|never mind|nevermind|what is|what's|explain|define|why does)\b/i.test(text)) return null
  if (/\b(?:show|open|bring up|use)\s+(?:me\s+)?(?:a\s+|the\s+)?map\b|\bmap\s+(?:of|for|around)\b|\b(?:find|show|locate)\s+(?:me\s+)?(?:nearby\s+)?(?:restaurants?|cafes?|hotels?|places?|properties|homes|apartments?)\b/i.test(text)) return { view: 'map', query: text }
  if (/\b(?:open|show|go to)\s+(?:my\s+|the\s+)?(?:memory|saved work)\b/i.test(text)) return { view: 'memory' }
  if (/\b(?:open|show|use)\s+(?:the\s+)?(?:autopilot|workflows?)\b/i.test(text)) return { view: 'agents' }
  if (/\b(?:open|show|use)\s+(?:the\s+)?(?:studio)\b/i.test(text)) return { view: 'studio' }
  // Text about an artifact does not request construction of that artifact.
  if (/\b(?:checklist|summary|critique|explanation|feedback)\s+(?:of|for|about|on)\b/i.test(text)) return null
  const intent = fallbackStudioIntent(text)
  return intent.kind === 'chat' ? null : { view: 'studio', studioKind: intent.kind }
}
