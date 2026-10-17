/** Names must come from user-authored brief text, never profiles or question examples. */
export function logoRequestText(body: Record<string, unknown>, prompt: string): string {
  const brief = body.logoBrief && typeof body.logoBrief === 'object' ? body.logoBrief as Record<string, unknown> : null
  const clean = (value: string) => value
    .replace(/\n\nQuestions asked:[\s\S]*?The user has now answered below[^\n]*\n\n/gi, '\n\nUser answers:\n')
    .split(/\n\n---\n\[Attached context for this request/)[0]
    .replace(/^ORIGINAL REQUEST:\s*/i, '').trim()
  return brief && typeof brief.request === 'string'
    ? [clean(brief.request), typeof brief.answers === 'string' ? clean(brief.answers) : ''].filter(Boolean).join('\n\nUser answers:\n')
    : clean(prompt)
}

export function enforceLogoName(payload: Record<string, unknown>, request: string): Record<string, unknown> {
  // A directly supplied title/name is source text, even when the model omitted
  // it. Stop before audience/style instructions; never infer from "for unicorns".
  const named = [...request.matchAll(/\b(?:called|named|titled|(?:brand|logo|book) name(?: is|:))\s+["“]([^"”\n]{1,100})["”]|\b(?:called|named|titled|(?:brand|logo|book) name(?: is|:))\s+([^\n.!?]{1,100}?)(?=\s+(?:for|with|in|using)\b|[.!?\n]|$)/gi)].slice(-1)[0]
  const explicitName = (named?.[1] || named?.[2] || '').trim()
  const name = explicitName || (typeof payload.name === 'string' ? payload.name.trim() : '')
  // The name must be a verbatim span of the user's own text. Missing names stay
  // empty; UI labels like "Logo" must never become artwork or monogram letters.
  const source = request.normalize('NFKC').toLocaleLowerCase()
  const normalized = name.normalize('NFKC').toLocaleLowerCase()
  const index = normalized ? source.indexOf(normalized) : -1
  const supported = index >= 0 && !/[\p{L}\p{N}]/u.test(source[index - 1] || '') && !/[\p{L}\p{N}]/u.test(source[index + normalized.length] || '')
  const initials = explicitName && name !== payload.name ? explicitName.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).slice(0, 2).map(word => word[0]).join('').toUpperCase() : typeof payload.initials === 'string' ? payload.initials.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2) : ''
  const explicitInitials = !!initials && new RegExp(`(?:\\b(?:initials?|letters?|monogram|text)[:\\s]+(?:(?:are|is|of|says?|with)\\s+)?["'“‘]?${initials}\\b|\\b${initials}["'”’]?\\s+(?:initials?|letters?|monogram)\\b)`, 'i').test(request)
  const next = { ...payload, name: supported ? name : '', initials: supported || explicitInitials ? initials : '' }
  if (!supported) {
    // Unsupported generated text must not survive in alternate wordmark fields.
    for (const key of ['mark','lockup','options']) delete (next as Record<string, unknown>)[key]
  }
  return next
}

export const LOGO_NAME_RULE = `LOGO NAME PROVENANCE: Use a name only when the user's own request or answers explicitly provide it as text for this logo. A subject ('unicorns'), audience ('younger folks'), genre ('fantasy book'), assistant question example, profile name, and saved brand are NOT permission to invent a business or person. If the user gives no logo name, return name:"" and initials:"" and make the requested pictorial mark. Exception: preserve explicitly requested letters or initials, such as 'a monogram with the letters JB', while leaving the name empty. Never turn the topic into a made-up brand. Preserve the requested subject and style. A whimsical unicorn for a young audience must depict a whimsical unicorn, not a monogram. Treat the original request and user answers together as the brief.`
