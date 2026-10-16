# Studio presentation fonts

This bounded catalog is bundled with the app under the SIL Open Font License
1.1. Keep each accompanying `LICENSE_*` file with its fonts. Full source URLs,
file sizes, modification notes, and SHA-256 digests are in `font-sources.json`.

| Family | Files | License |
| --- | --- | --- |
| Inter | Regular, Bold, Italic, BoldItalic | LICENSE_Inter |
| Poppins | Regular, Bold, Italic, BoldItalic | LICENSE_Poppins |
| Source Serif 4 | Regular, Bold, It, BoldIt | LICENSE_SourceSerif4 |
| JetBrains Mono | Regular, Bold, Italic, BoldItalic | LICENSE_JetBrainsMono |
| Liberation Sans, Serif, Mono | Regular, Bold, Italic, BoldItalic | LICENSE_LIBERATION |

Inter files are static instances of the official variable sources, at weight
400/700 and optical size 14, generated with fontTools without subsetting glyphs.
Inter's included license notice declares no Reserved Font Name. The other fonts
are unmodified static TrueType files from their official projects.

`slideFonts.ts` loads only a deck's resolved families from this same-origin
directory. Preview and PDF use those fonts; PowerPoint retains the user's chosen
font names. Unsupported families resolve to a disclosed same-category fallback.
PDF rejects unsupported characters instead of omitting or replacing their text.
This catalog does not provide universal script coverage or custom font uploads.

Maintainer-only refresh: `python3 scripts/slide-font-assets.py --download`.
This intentionally requires network access and fontTools. Review source/license
and manifest changes; it is not a runtime or build dependency. Validate changes
with `node scripts/slide-font-qa.mjs` (local browser plus Poppler required).
