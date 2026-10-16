// Shared text cleanup for generated ARTIFACT content (docs, decks, sheets) — the same
// rules the chat applies in cleanForDisplay, but reusable so artifact previews AND their
// exports come out identical: no em/en dashes, and no internal design-language / 3rd-party
// names surfaced (it's all Nalu). Real 3rd-party mentions in a design context are
// genericized; the internal-only compound codenames are removed anywhere. Bare company
// names in normal prose/data are left alone (the patterns require a design context).

export function stripDashes(s: string): string {
  return s
    .replace(/(\w)\s*—\s*(\w)/g, '$1 - $2') // word—word → word - word
    .replace(/\s*—\s*/g, ' - ') // any remaining em dash → spaced hyphen
    .replace(/(\d)\s*–\s*(\d)/g, '$1-$2') // 3–5 → 3-5
    .replace(/\s*–\s*/g, ' - ') // any remaining en dash → spaced hyphen
}

const DL_NAMES =
  'Kami Editorial|Stripe|Linear Graphite|Cal Mono|Claude Parchment|OpenAI Signal|IBM Carbon|Coinbase Blue|Bugatti Noir|Nike Podium|Duolingo Play|Mistral Golden|Composio Terminal|Mission Control|Starbucks|Replicate|Notion|Linear'

export function scrubThirdParty(s: string): string {
  if (!s) return s
  // ONLY the context-gated forms ("<name> design language", "rooted in <name>") — these
  // are how an internal design-language name leaks into output. A BARE compound name is
  // left alone: a user's deck/sheet can legitimately be ABOUT "IBM Carbon", "Nike Podium",
  // etc., and must not be silently rewritten to "Nalu".
  return s
    .replace(new RegExp(`\\b(?:${DL_NAMES})[-\\s]?(design language|design system|aesthetic|design|style|look|typography|palette|editorial)\\b`, 'gi'), 'Nalu $1')
    .replace(new RegExp(`\\b(rooted in|inspired by|based on|drawing on|reminiscent of|in the (?:style|spirit) of|akin to)\\s+(?:the\\s+)?(?:${DL_NAMES})\\b`, 'gi'), '$1 Nalu’s own design language')
}

/** Clean one string of artifact content (dashes + 3rd-party names). No-op on non-strings. */
export function cleanArtifactText(s: string): string {
  if (!s || typeof s !== 'string') return s
  return scrubThirdParty(stripDashes(s))
}

// Deep-clean a DECK's text (title, subtitle, each slide's title + bullets) while
// preserving every other field (design, chart, image, notes, …) via spread.
type DeckLike = { title?: string; subtitle?: string; slides?: Array<Record<string, unknown>> } & Record<string, unknown>
export function cleanDeck<T extends DeckLike>(d: T): T {
  // A deck may quote a brand's design system or contain meaningful symbols.
  // Preserve those words; structural normalization happens in SlidesCard.
  return d
}

// Deep-clean a SHEET's text (title, sheet names, column headers, and STRING cells only —
// numbers and formulas ("=…") are left untouched). Preserves every other field.
type SheetLike = { title?: string; sheets?: Array<Record<string, unknown>> } & Record<string, unknown>
export function cleanSheet<T extends SheetLike>(d: T): T {
  if (!d || typeof d !== 'object') return d
  const cell = (c: unknown) => (typeof c === 'string' && !c.startsWith('=') ? cleanArtifactText(c) : c)
  return {
    ...d,
    ...(typeof d.title === 'string' ? { title: cleanArtifactText(d.title) } : {}),
    ...(Array.isArray(d.sheets)
      ? {
          sheets: d.sheets.map((s) =>
            s && typeof s === 'object'
              ? {
                  ...s,
                  ...(typeof s.name === 'string' ? { name: cleanArtifactText(s.name) } : {}),
                  ...(Array.isArray(s.columns) ? { columns: (s.columns as unknown[]).map(cell) } : {}),
                  ...(Array.isArray(s.rows) ? { rows: (s.rows as unknown[][]).map((r) => (Array.isArray(r) ? r.map(cell) : r)) } : {}),
                }
              : s,
          ),
        }
      : {}),
  } as T
}
