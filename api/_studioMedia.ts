export type StudioMediaPreference = { omitGenerated: boolean; omitAttached: boolean }

// Interpret explicit media directions, rather than treating every mention of an
// image as a request to generate one. Later explicit directions can change an
// earlier choice; existing/attached media are distinct from new stock/AI photos.
export function studioMediaPreference(prompt: string): StudioMediaPreference {
  const text = prompt.toLowerCase().replace(/[‘’]/g, "'")
  const events: Array<{ index: number; scope: 'all' | 'generated' | 'attached'; omit: boolean }> = []
  const media = '(?:photos?|photographs?|images?|pictures?|illustrations?|photography)'
  const modifiers = '(?:(?:any|all|the|new|additional|external|stock|generated|ai[- ]generated|decorative|attached|uploaded|provided|supplied|my|our)\\s+)*'
  const add = (pattern: RegExp, omit: boolean, force?: 'all' | 'generated' | 'attached') => {
    for (const match of text.matchAll(pattern)) {
      const index = match.index!
      const prefix = text.slice(Math.max(0, index - 30), index)
      if (!omit && /(?:don't|do not|never|not|without)\s*$/.test(prefix)) continue
      if (omit && /(?:don't|do not|not|no need to)\s*$/.test(prefix)) continue
      // "There are no photos in the source" describes input, not an opt-out.
      if (/\bno\s/.test(match[0]) && /^\s+(?:in|from)\s+(?:the\s+)?(?:source|brief|document|attachment|input)/.test(text.slice(index + match[0].length))) continue
      // A restriction on the SUBJECT of a photo does not prohibit every photo.
      if (omit && /^\s+(?:of|with|showing|depicting)\s/.test(text.slice(index + match[0].length))) continue
      const scope = force || (/\b(?:external|stock|generated|new|additional|generate)\b/.test(match[0]) ? 'generated' : /\b(?:attached|uploaded|provided|supplied|my|our)\b/.test(match[0]) ? 'attached' : 'all')
      events.push({ index, scope, omit })
    }
  }
  add(/\btext[- ]only\b|\b(?:photo|image|picture)[- ]free\b/g, true, 'all')
  add(new RegExp(`\\b(?:no|without)\\s+${modifiers}${media}\\b`, 'g'), true)
  add(new RegExp(`\\b(?:omit|remove|exclude|skip|avoid)\\s+${modifiers}${media}\\b`, 'g'), true)
  add(new RegExp(`\\b(?:don't|do not|never)\\s+(?:include|add|generate|use|show)\\s+${modifiers}${media}\\b`, 'g'), true)
  add(new RegExp(`\\b${modifiers}${media}\\s+(?:are|is)\\s+not\\s+(?:needed|required|necessary|wanted)\\b`, 'g'), true)
  // A negative list can place the media term after other omitted items.
  add(new RegExp(`\\bno\\s+[^.!?;\\n]{0,240}?\\b${modifiers}${media}\\s+(?:are|is)\\s+(?:needed|required|necessary|wanted)\\b`, 'g'), true)
  add(new RegExp(`\\b(?:include|add|use|generate|show|keep|retain)\\s+${modifiers}${media}\\b`, 'g'), false)
  for (const match of text.matchAll(new RegExp(`\\b(?:only\\s+(?:use|include)|(?:use|include)\\s+only)\\s+(?:the\\s+|my\\s+|our\\s+)?(?:attached|uploaded|provided|supplied)\\s+${media}\\b`, 'g'))) {
    events.push({ index: match.index! + match[0].length, scope: 'generated', omit: true })
    events.push({ index: match.index! + match[0].length, scope: 'attached', omit: false })
  }
  const preference = { omitGenerated: false, omitAttached: false }
  for (const event of events.sort((a, b) => a.index - b.index)) {
    if (event.scope !== 'attached') preference.omitGenerated = event.omit
    if (event.scope !== 'generated') preference.omitAttached = event.omit
  }
  return preference
}

export function studioMediaInstruction(preference: StudioMediaPreference): string {
  if (!preference.omitGenerated && !preference.omitAttached) return ''
  return `\n\nMEDIA CHOICE: ${preference.omitGenerated ? 'The user opted out of generated photos/images. Set cover and every generated image prompt to "". Do not add stock photos, decorative imagery, or image-based slide layouts; use the requested text/data structure.' : ''}${preference.omitAttached ? ' Do not embed attached images in the deliverable.' : ' Keep user-attached media where requested; an external-photo opt-out does not discard those attachments.'}`
}
