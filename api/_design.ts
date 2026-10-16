// api/_design.ts — Nalu's shared studio DESIGN ENGINE.
//
// Distilled from open-design's 151 named design systems + its anti-AI-slop craft
// rules into 16 curated, maximally-distinct design languages. EVERY studio generator
// (slides / doc / email / sheet) calls pickDesign() to resolve ONE language for the
// request, ships designPayload() on its JSON so the client Card renders that
// language's palette + type + shape (not one hardcoded look), and injects
// designDirective() into the model prompt so the COPY and image art-direction fit
// the language too. This is what makes Nalu's output look designed, not generated,
// and lets a user say "make it like Stripe / brutalist / a coffee brand" and get it.

export type Palette = { bg: string; surface: string; ink: string; muted: string; accent: string; accent2: string }
export type Fonts = { display: string; body: string; mono: string }
export type DesignLanguage = {
  id: string; name: string; vibe: string; whenToUse: string; keywords: string[]
  light: Palette; dark: Palette; fonts: Fonts; layout: string; motif: string; radius: number
}
export type ResolvedDesign = Omit<DesignLanguage, 'fonts'> & { fonts: Fonts & { displaySerif: boolean; bodySerif: boolean } }

export const LANGUAGES: DesignLanguage[] = [
  {
    "id": "stripe",
    "name": "Stripe",
    "vibe": "World-class fintech: feather-light navy headlines on white, saturated violet, and blue-tinted floating shadows — precise yet luxurious.",
    "whenToUse": "The universal clean-minimal choice: fintech and investor decks, payments/banking, B2B SaaS docs, sales and pricing pages, and financial dashboards where refinement and trust are the whole message.",
    "keywords": [
      "finance",
      "fintech",
      "payments",
      "saas",
      "b2b",
      "enterprise",
      "banking",
      "dashboard",
      "developer",
      "invoice",
      "professional",
      "deck",
      "clean",
      "minimal",
      "stripe",
      "refined",
      "default"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#f6f9fc",
      "ink": "#061b31",
      "muted": "#64748d",
      "accent": "#533afd",
      "accent2": "#ea2261"
    },
    "dark": {
      "bg": "#0d253d",
      "surface": "#1c1e54",
      "ink": "#f4f7ff",
      "muted": "#b9b9f9",
      "accent": "#665efd",
      "accent2": "#f96bee"
    },
    "fonts": {
      "display": "Sora, Inter, 'SF Pro Display', system-ui, sans-serif",
      "body": "Inter, 'SF Pro Text', system-ui, sans-serif",
      "mono": "'Source Code Pro', ui-monospace, monospace"
    },
    "layout": "Centered ~1080px column with precise, measured whitespace; white sections alternate with deep-indigo brand bands, hierarchy carried by type not decoration.",
    "motif": "Whisper-weight (300) deep-navy headlines lifted off white by multi-layer blue-tinted shadows (rgba(50,50,93,0.15)); a single violet accent for eyebrow + CTA.",
    "radius": 8
  },
  {
    "id": "linear-graphite",
    "name": "Linear Graphite",
    "vibe": "Darkness as the native medium — content emerges from near-black like starlight, one indigo-violet the only color.",
    "whenToUse": "Technical dark-mode reports, developer and engineering product surfaces, changelogs, modern startup SaaS decks, and precise analytics dashboards.",
    "keywords": [
      "saas",
      "developer",
      "darkmode",
      "engineering",
      "product",
      "changelog",
      "technical",
      "startup",
      "dashboard",
      "minimal",
      "report",
      "precise",
      "linear",
      "vercel"
    ],
    "light": {
      "bg": "#f7f8f8",
      "surface": "#ffffff",
      "ink": "#16171a",
      "muted": "#62666d",
      "accent": "#5e6ad2",
      "accent2": "#7170ff"
    },
    "dark": {
      "bg": "#08090a",
      "surface": "#191a1b",
      "ink": "#f7f8f8",
      "muted": "#8a8f98",
      "accent": "#7170ff",
      "accent2": "#5e6ad2"
    },
    "fonts": {
      "display": "Inter, 'SF Pro Display', system-ui, sans-serif",
      "body": "Inter, system-ui, sans-serif",
      "mono": "'JetBrains Mono', 'SF Mono', ui-monospace, monospace"
    },
    "layout": "Near-black ~1200px canvas; elevation via luminance-stepped translucent surfaces (rgba white 0.02→0.05) on an 8px grid; compressed display headlines in vast dark padding.",
    "motif": "Semi-transparent white hairline borders instead of solid lines; aggressive negative letter-spacing on display type; single indigo-violet accent for CTAs only; translucent surfaces over drop shadows.",
    "radius": 8
  },
  {
    "id": "cal-mono",
    "name": "Cal Mono",
    "vibe": "Grayscale confidence — boldness through contrast, never color; clean product docs that feel precise and uncluttered.",
    "whenToUse": "Clean SaaS docs, product one-pagers, changelogs, Notion/shadcn-style minimal pages, and developer-facing material that should feel modern and neutral.",
    "keywords": [
      "saas",
      "clean",
      "minimal",
      "grayscale",
      "monochrome",
      "product",
      "developer",
      "documentation",
      "startup",
      "notion",
      "shadcn",
      "tool",
      "professional"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#f5f5f5",
      "ink": "#242424",
      "muted": "#898989",
      "accent": "#242424",
      "accent2": "#0099ff"
    },
    "dark": {
      "bg": "#111111",
      "surface": "#1e1f23",
      "ink": "#f4f4f4",
      "muted": "#898989",
      "accent": "#f4f4f4",
      "accent2": "#0099ff"
    },
    "fonts": {
      "display": "'Cal Sans', Inter, system-ui, sans-serif",
      "body": "Inter, system-ui, sans-serif",
      "mono": "'Roboto Mono', ui-monospace, monospace"
    },
    "layout": "Lavish 80–96px section whitespace on a centered ~1200px canvas; product-screenshot-first; maximum ink-on-white contrast.",
    "motif": "Tight-tracked Cal Sans display headings; multi-layer ring + contact shadows instead of CSS borders; color reserved strictly for links.",
    "radius": 8
  },
  {
    "id": "claude-parchment",
    "name": "Claude Parchment",
    "vibe": "A literary salon on warm paper — unhurried, human, quietly intellectual.",
    "whenToUse": "Warm consumer, editorial, wellness, and thoughtful-AI content — long-form essays, brand stories, and decks that should feel like a well-made book.",
    "keywords": [
      "warm",
      "editorial",
      "literary",
      "serif",
      "parchment",
      "thoughtful",
      "human",
      "wellness",
      "publishing",
      "essay",
      "craft",
      "ai",
      "claude",
      "anthropic",
      "cozy"
    ],
    "light": {
      "bg": "#f5f4ed",
      "surface": "#faf9f5",
      "ink": "#141413",
      "muted": "#5e5d59",
      "accent": "#c96442",
      "accent2": "#d97757"
    },
    "dark": {
      "bg": "#141413",
      "surface": "#30302e",
      "ink": "#faf9f5",
      "muted": "#b0aea5",
      "accent": "#d97757",
      "accent2": "#c96442"
    },
    "fonts": {
      "display": "Fraunces, Georgia, 'Times New Roman', serif",
      "body": "Inter, system-ui, sans-serif",
      "mono": "'JetBrains Mono', ui-monospace, monospace"
    },
    "layout": "Magazine pacing on a centered ~1200px column; light and dark sections alternate like book chapters; relaxed 1.6 body leading.",
    "motif": "Single-weight (500) serif headlines with book-title gravitas; warm ring shadows (0 0 0 1px) standing in for borders; organic hand-drawn illustration.",
    "radius": 12
  },
  {
    "id": "kami-editorial",
    "name": "Kami Editorial",
    "vibe": "Warm parchment and ink-blue, serif carries everything — good content printed on good paper.",
    "whenToUse": "White papers, one-pagers, résumés, research reports, equity memos, proposals, and long-form documents that should read like premium print rather than app UI.",
    "keywords": [
      "editorial",
      "whitepaper",
      "resume",
      "report",
      "serif",
      "document",
      "deck",
      "proposal",
      "publishing",
      "print",
      "research",
      "one-pager",
      "memo",
      "academic"
    ],
    "light": {
      "bg": "#f5f4ed",
      "surface": "#faf9f5",
      "ink": "#141413",
      "muted": "#504e49",
      "accent": "#1b365d",
      "accent2": "#2d5a8a"
    },
    "dark": {
      "bg": "#141413",
      "surface": "#30302e",
      "ink": "#f5f4ed",
      "muted": "#b3afa4",
      "accent": "#2d5a8a",
      "accent2": "#4d78ab"
    },
    "fonts": {
      "display": "'Source Serif 4', Charter, Georgia, serif",
      "body": "'Source Serif 4', Charter, Georgia, serif",
      "mono": "'JetBrains Mono', ui-monospace, monospace"
    },
    "layout": "Centered ~1120px column, generous print margins, 72px section gaps; section-number + serif-title stacks over dense tabular-num tables.",
    "motif": "One serif weight (500) with size carrying hierarchy; ink-blue section numerals and en-dash bullets; 1px ring and 0 4px 24px whisper shadows — no bold, no italic.",
    "radius": 8
  },
  {
    "id": "openai-signal",
    "name": "OpenAI Signal",
    "vibe": "Research lab dressed for the public — calm near-monochrome with a literary serif and a single teal signal.",
    "whenToUse": "Clean SaaS documentation, product announcements, thought-leadership pieces, and fintech decks that need quiet credibility with editorial polish.",
    "keywords": [
      "clean",
      "saas",
      "editorial",
      "serif",
      "calm",
      "minimal",
      "teal",
      "documentation",
      "research",
      "professional",
      "announcement",
      "fintech",
      "openai",
      "thought-leadership"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#f5f5f5",
      "ink": "#0d0d0d",
      "muted": "#6e6e6e",
      "accent": "#10a37f",
      "accent2": "#0a7a5e"
    },
    "dark": {
      "bg": "#0d0d0d",
      "surface": "#1a1a1a",
      "ink": "#ececec",
      "muted": "#9b9b9b",
      "accent": "#19c39c",
      "accent2": "#10a37f"
    },
    "fonts": {
      "display": "'Source Serif 4', Georgia, serif",
      "body": "Inter, system-ui, -apple-system, sans-serif",
      "mono": "'JetBrains Mono', ui-monospace, monospace"
    },
    "layout": "Generous whitespace with reading-width 12-column columns; soft-radius cards and hairline dividers instead of color blocks.",
    "motif": "Serif editorial display against restrained sans body; sparse teal accent; whitespace as the primary divider.",
    "radius": 14
  },
  {
    "id": "starbucks",
    "name": "Starbucks",
    "vibe": "Warm retail flagship — cream canvas, storefront green, gold ceremony, and pill-soft geometry that feels like good coffee.",
    "whenToUse": "Warm consumer and retail brands, food/beverage, hospitality, loyalty programs, and lifestyle products that should feel warm, premium, and human rather than clinical.",
    "keywords": [
      "coffee",
      "cafe",
      "retail",
      "hospitality",
      "food",
      "beverage",
      "loyalty",
      "warm",
      "consumer",
      "lifestyle",
      "rewards",
      "brand",
      "organic",
      "green"
    ],
    "light": {
      "bg": "#f2f0eb",
      "surface": "#ffffff",
      "ink": "#1e3932",
      "muted": "#6f6a63",
      "accent": "#00754a",
      "accent2": "#cba258"
    },
    "dark": {
      "bg": "#1e3932",
      "surface": "#2b5148",
      "ink": "#f4f7f5",
      "muted": "#d4e9e2",
      "accent": "#cba258",
      "accent2": "#9fd9bf"
    },
    "fonts": {
      "display": "Manrope, 'Segoe UI', sans-serif",
      "body": "Inter, 'Segoe UI', sans-serif",
      "mono": "'IBM Plex Mono', ui-monospace, monospace"
    },
    "layout": "Asymmetric 40/60 hero split with cream→white→deep-green color-block banding and generous café whitespace instead of dividers.",
    "motif": "Warm cream canvas broken by espresso-green (#1e3932) full-bleed bands; every button a full 50px pill; gold reserved only for reward moments.",
    "radius": 12
  },
  {
    "id": "bugatti-noir",
    "name": "Bugatti Noir",
    "vibe": "A car film you happen to be standing inside — monumental, monochrome, silent luxury.",
    "whenToUse": "Luxury and premium brand decks — hypercars, fashion, watches, couture — where full-bleed imagery and monumental type carry all the drama.",
    "keywords": [
      "luxury",
      "premium",
      "hypercar",
      "automotive",
      "fashion",
      "couture",
      "watches",
      "monochrome",
      "cinematic",
      "exclusive",
      "high-end",
      "showroom",
      "ferrari",
      "lamborghini",
      "elegant"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#f2f2f2",
      "ink": "#0a0a0a",
      "muted": "#7d7d7d",
      "accent": "#0a0a0a",
      "accent2": "#666666"
    },
    "dark": {
      "bg": "#0a0a0a",
      "surface": "#141414",
      "ink": "#f4f4f4",
      "muted": "#999999",
      "accent": "#f4f4f4",
      "accent2": "#999999"
    },
    "fonts": {
      "display": "Unbounded, 'Archivo', Impact, sans-serif",
      "body": "Inter, system-ui, sans-serif",
      "mono": "'Space Mono', ui-monospace, monospace"
    },
    "layout": "Cinematic single-column full-bleed stack; each block gets its own silent room; ultra-wide canvas up to 1720px.",
    "motif": "Monumental ALL-CAPS display over full-bleed black; thin 1px outline pill buttons; mono uppercase labels at 1.4px tracking; elevation by surface, not shadow.",
    "radius": 0
  },
  {
    "id": "mistral-golden",
    "name": "Mistral Golden Hour",
    "vibe": "Sun-drenched French luxury — molten amber warmth meets sharp architectural restraint.",
    "whenToUse": "Premium brand stories, luxury product launches, and bold declarative decks or warm editorial where a golden, confident temperature should carry authority without decoration.",
    "keywords": [
      "luxury",
      "warm",
      "amber",
      "gold",
      "premium",
      "bold",
      "editorial",
      "brand",
      "fashion",
      "hospitality",
      "declarative",
      "wine",
      "hero"
    ],
    "light": {
      "bg": "#fffaeb",
      "surface": "#fff0c2",
      "ink": "#1f1f1f",
      "muted": "#5a5443",
      "accent": "#fa520f",
      "accent2": "#b26a00"
    },
    "dark": {
      "bg": "#1f1f1f",
      "surface": "#2a2622",
      "ink": "#fffaeb",
      "muted": "#b8a888",
      "accent": "#fb6424",
      "accent2": "#ffb83e"
    },
    "fonts": {
      "display": "Archivo, 'Helvetica Neue', Arial, sans-serif",
      "body": "Inter, Helvetica, Arial, sans-serif",
      "mono": "'IBM Plex Mono', ui-monospace, monospace"
    },
    "layout": "Billboard-scale headlines over generous warm-ivory whitespace; wide left-aligned blocks and full-bleed golden imagery.",
    "motif": "Massive single-weight display type with sharp zero-radius edges and cascading amber 'golden-hour' shadows; one ember accent for the primary move.",
    "radius": 0
  },
  {
    "id": "nike-podium",
    "name": "Nike Podium",
    "vibe": "Stadium-scale monochrome — oversized uppercase type that punches, with color left entirely to the imagery.",
    "whenToUse": "Bold creative pitches, athletic and streetwear brands, launch campaigns, and image-led editorial decks where huge type and full-bleed photography lead.",
    "keywords": [
      "bold",
      "athletic",
      "sport",
      "monochrome",
      "editorial",
      "retail",
      "streetwear",
      "campaign",
      "fashion",
      "fitness",
      "launch",
      "high-contrast",
      "brutalist",
      "poster",
      "nike"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#f5f5f5",
      "ink": "#111111",
      "muted": "#707072",
      "accent": "#111111",
      "accent2": "#d30005"
    },
    "dark": {
      "bg": "#111111",
      "surface": "#1f1f21",
      "ink": "#f4f4f4",
      "muted": "#9e9ea0",
      "accent": "#f4f4f4",
      "accent2": "#ff5000"
    },
    "fonts": {
      "display": "Oswald, Impact, 'Helvetica Neue', sans-serif",
      "body": "Inter, 'Helvetica Neue', Arial, sans-serif",
      "mono": "'IBM Plex Mono', ui-monospace, monospace"
    },
    "layout": "Full-bleed edge-to-edge photography on a tight 8px grid; massive uppercase headlines and a deliberately monochrome UI.",
    "motif": "Condensed uppercase display at 0.90 line-height, pure ink-on-white, pill CTAs, zero shadows; the one red only on a decisive accent.",
    "radius": 2
  },
  {
    "id": "coinbase-blue",
    "name": "Coinbase Blue",
    "vibe": "Institutional trust rendered in one confident cobalt — clean, binary, financial-grade.",
    "whenToUse": "Fintech and crypto decks, banking and payments dashboards, investor updates, and clean SaaS docs where credibility, clarity, and a trustworthy feel matter most.",
    "keywords": [
      "finance",
      "fintech",
      "crypto",
      "banking",
      "payments",
      "investing",
      "institutional",
      "trust",
      "saas",
      "dashboard",
      "exchange",
      "blue",
      "corporate",
      "investor"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#eef0f3",
      "ink": "#0a0b0d",
      "muted": "#5b616e",
      "accent": "#0052ff",
      "accent2": "#578bfa"
    },
    "dark": {
      "bg": "#0a0b0d",
      "surface": "#282b31",
      "ink": "#f4f5f7",
      "muted": "#8a919e",
      "accent": "#578bfa",
      "accent2": "#0052ff"
    },
    "fonts": {
      "display": "Sora, Inter, system-ui, sans-serif",
      "body": "Inter, system-ui, sans-serif",
      "mono": "'IBM Plex Mono', ui-monospace, monospace"
    },
    "layout": "8px-grid with a wide centered container; generous section breaks alternating crisp white and near-black full-width bands.",
    "motif": "Oversized pill CTAs (56px radius) in a single cobalt, with light-to-dark section alternation carrying the hierarchy.",
    "radius": 12
  },
  {
    "id": "duolingo-play",
    "name": "Duo Play",
    "vibe": "Gamified joy — owl-green energy, chunky pressable buttons, oversized confident type; the interface smiles.",
    "whenToUse": "Bold creative pitches, consumer and education apps, kids and gamified products, playful marketing decks and upbeat onboarding.",
    "keywords": [
      "playful",
      "consumer",
      "education",
      "gamified",
      "kids",
      "bold",
      "friendly",
      "fun",
      "app",
      "energetic",
      "green",
      "rounded",
      "onboarding",
      "duolingo"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#f7f7f7",
      "ink": "#3c3c3c",
      "muted": "#777777",
      "accent": "#58cc02",
      "accent2": "#ff9600"
    },
    "dark": {
      "bg": "#131f24",
      "surface": "#202f36",
      "ink": "#f5f5f5",
      "muted": "#94a3a7",
      "accent": "#58cc02",
      "accent2": "#ff9600"
    },
    "fonts": {
      "display": "'Baloo 2', Nunito, sans-serif",
      "body": "Nunito, system-ui, sans-serif",
      "mono": "'JetBrains Mono', ui-monospace, monospace"
    },
    "layout": "White single-column ~1080px container with big confident type, a 4px spacing rhythm, and centered content.",
    "motif": "Chunky 4px bottom-shadow 'pressable' buttons, 2–3px solid borders, and oversized rounded display type.",
    "radius": 16
  },
  {
    "id": "composio-terminal",
    "name": "Composio Terminal",
    "vibe": "Nocturnal developer command center — pitch-black canvas, hairline borders, bioluminescent cyan signals.",
    "whenToUse": "Technical dark-mode reports, developer tooling and infrastructure, API and engineering docs, and code- or terminal-centric dashboards.",
    "keywords": [
      "developer",
      "technical",
      "dark",
      "terminal",
      "code",
      "infrastructure",
      "api",
      "engineering",
      "devtools",
      "backend",
      "cyan",
      "monospace",
      "docs"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#f4f6fb",
      "ink": "#0f0f0f",
      "muted": "#565b66",
      "accent": "#0007cd",
      "accent2": "#0089ff"
    },
    "dark": {
      "bg": "#0f0f0f",
      "surface": "#17181d",
      "ink": "#f0f0f0",
      "muted": "#8a8a8a",
      "accent": "#00d4d4",
      "accent2": "#0089ff"
    },
    "fonts": {
      "display": "'Space Grotesk', Inter, sans-serif",
      "body": "Inter, system-ui, sans-serif",
      "mono": "'JetBrains Mono', ui-monospace, monospace"
    },
    "layout": "1200px centered column with asymmetric feature grids, low-opacity hairline containment, and large section gaps.",
    "motif": "Hairline white-opacity borders and monospace stat labels over void-black, with cyan glow halos and hard-offset brutalist shadows.",
    "radius": 4
  },
  {
    "id": "replicate",
    "name": "Replicate",
    "vibe": "A developer festival poster — one explosive orange-to-magenta gradient, massive heavy display type, and everything shaped like a pill.",
    "whenToUse": "Bold creative pitches, product and startup/AI launches, hackathon and community energy, hero landing moments that should feel loud, playful, and confident.",
    "keywords": [
      "creative",
      "bold",
      "pitch",
      "launch",
      "startup",
      "ai",
      "playful",
      "gradient",
      "energetic",
      "poster",
      "community",
      "developer",
      "vibrant"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#f8f8f8",
      "ink": "#202020",
      "muted": "#646464",
      "accent": "#ea2804",
      "accent2": "#2b9a66"
    },
    "dark": {
      "bg": "#202020",
      "surface": "#24292e",
      "ink": "#fcfcfc",
      "muted": "#bbbbbb",
      "accent": "#ff4a24",
      "accent2": "#2b9a66"
    },
    "fonts": {
      "display": "Archivo, Helvetica, sans-serif",
      "body": "'DM Sans', Helvetica, sans-serif",
      "mono": "'JetBrains Mono', ui-monospace, monospace"
    },
    "layout": "Full-width gradient hero, then a clean white canvas with dense gallery grids and vast 96–192px gaps between sections.",
    "motif": "One explosive orange→magenta gradient block reserved for the hero only; everything else pill-shaped (9999px) with oversized heavy display type and dotted-underline links.",
    "radius": 999
  },
  {
    "id": "ibm-carbon",
    "name": "IBM Carbon",
    "vibe": "Engineering spec rendered as a page — white canvas, light-weight display, one electric blue, zero rounded corners.",
    "whenToUse": "Enterprise and fintech decks, clean SaaS product docs, technical documentation, data dashboards, and B2B governance material that needs corporate precision.",
    "keywords": [
      "enterprise",
      "fintech",
      "saas",
      "corporate",
      "technical",
      "dashboard",
      "documentation",
      "b2b",
      "data",
      "governance",
      "professional",
      "blue",
      "carbon",
      "ibm"
    ],
    "light": {
      "bg": "#ffffff",
      "surface": "#f4f4f4",
      "ink": "#161616",
      "muted": "#525252",
      "accent": "#0f62fe",
      "accent2": "#0043ce"
    },
    "dark": {
      "bg": "#161616",
      "surface": "#262626",
      "ink": "#f4f4f4",
      "muted": "#c6c6c6",
      "accent": "#78a9ff",
      "accent2": "#4589ff"
    },
    "fonts": {
      "display": "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif",
      "body": "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif",
      "mono": "'IBM Plex Mono', Menlo, monospace"
    },
    "layout": "Strict 16-column 2x grid on an 8px scale; depth via background-color layering (white→#f4f4f4→#e0e0e0); left-aligned full-bleed content bands.",
    "motif": "0px sharp corners on every button, card and input; single IBM Blue accent; bottom-border-only fields; light-weight (300) oversized display headlines; flat shadowless surfaces.",
    "radius": 0
  },
  {
    "id": "mission-control",
    "name": "Mission Control",
    "vibe": "Deep-space command console — amber telemetry on navy, monospace precision, zero decoration.",
    "whenToUse": "Technical dark-mode reports, real-time dashboards, financial data feeds, infrastructure and status decks, and any dense high-stakes readout.",
    "keywords": [
      "technical",
      "dark",
      "data",
      "dashboard",
      "telemetry",
      "monospace",
      "finance",
      "monitoring",
      "aerospace",
      "engineering",
      "metrics",
      "report",
      "status",
      "analytics"
    ],
    "light": {
      "bg": "#eef2f8",
      "surface": "#ffffff",
      "ink": "#0b1120",
      "muted": "#4a6080",
      "accent": "#a66a00",
      "accent2": "#0e7490"
    },
    "dark": {
      "bg": "#0b1120",
      "surface": "#111827",
      "ink": "#e8f0fe",
      "muted": "#8ba3c7",
      "accent": "#ffb800",
      "accent2": "#00d4ff"
    },
    "fonts": {
      "display": "'JetBrains Mono', ui-monospace, monospace",
      "body": "Inter, system-ui, sans-serif",
      "mono": "'JetBrains Mono', ui-monospace, monospace"
    },
    "layout": "Dense 12-column 4px grid of bordered panels; data-tile readouts, no wasted whitespace, hierarchy carried by alert color.",
    "motif": "Monospace amber numerals on deep navy with hairline borders and sharp 2–4px corners.",
    "radius": 4
  }
]

// The finalized anti-slop craft rules (prepended to every studio generation).
export const CRAFT_BLOCK = "Render in the RESOLVED design language — honor its palette tokens (bg/surface/ink/muted/accent/accent2), its display/body/mono fonts, and its radius exactly. Pick the light or dark palette to match the surface, then commit to it.\n\nNEVER emit default Tailwind indigo as an accent (#6366f1, #4f46e5, #4338ca, #3730a3, #8b5cf6, #7c3aed, #a855f7) — it is the #1 AI tell; use the language's --accent. Keep neutrals at 70–90% of pixels, accent at 5–10%, and show the accent at most TWICE per surface (e.g. one eyebrow + one CTA). Never invent a second accent beyond --accent2. No two-stop 'trust' gradients (purple→blue, blue→cyan, indigo→pink) on heroes/headers — a flat surface plus type hierarchy wins; a gradient is allowed only when the language's own motif calls for it (e.g. Replicate's single hero block). No emoji as icons (✨🚀🎯⚡🔥💡) or as decorative bullets inside headings, buttons, list items or badges — use 1.6–1.8px monoline SVG with currentColor. No rounded card that also carries a colored left-border tile (the canonical AI dashboard cliché) — drop one of the two.\n\nHeadings use the language's display font, never bare system-ui/Inter/Roboto; body uses its body font. Max 2 typefaces, 3 weights (read / emphasize / announce — weight jumps, never a 400→500→600→700 ladder), 6–8 sizes total with no more than 3 competing above the fold. Letter-spacing: ALL CAPS ≥0.06em, display ≥32px at -0.01em to -0.03em, body 0; body measure 50–75ch, never justified. Give each region ONE dominant entry point via ≥2 vectors (scale, weight, spacing, tracking, alignment); vary spacing to group, uniform spacing groups nothing.\n\nUse ONLY real numbers from the provided source data — never invent metrics ('10× faster', '99.9% uptime', '3× productivity'); label any placeholder honestly. No lorem, no 'feature one/two/three', no dummy strings — solve an empty section with composition. Meet contrast as a gate: 4.5:1 body, 3:1 large text and UI. Dark surfaces avoid pure #000/#fff (use the language's near-black/near-white tokens). Animate only navigation/state, ≤500ms (hovers ≤200ms), guarded by prefers-reduced-motion. Ship ~80% proven patterns plus the ONE distinctive move named in the language's motif so the output is unmistakably that language."

const DECK_LAYOUTS = 'cover-fullbleed, section-divider, agenda-toc, big-stat, stat-grid, three-up-cards, bento-uneven, two-col-image-text, image-grid, numbered-manifesto, process-steps, quote-fullbleed, comparison-two-col, data-table, chart-focus, pricing-tiers, team-grid, closing-cta'
const DOC_LAYOUTS = 'masthead, hero-cover, exec-summary, kpi-strip, stat-row, chart-block, data-table, pull-quote, callout, three-column-doc, code-block, toc-index, numbered-steps, signoff-block, section-heading'
const EMAIL_LAYOUTS = 'plain-personal, announcement-hero, newsletter-digest, transactional-receipt, cta-conversion, formal-letter'
const DEFAULT_ID = 'stripe'

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]))
const get = (id: string): DesignLanguage => BY_ID.get(id) || BY_ID.get(DEFAULT_ID) || LANGUAGES[0]

// A named face is "serif" for rendering when its FIRST family is a known serif — the
// client maps that to Times (PDF) / a serif stack (HTML) so a serif language actually
// reads as serif.
const SERIF_FIRST = /(serif|georgia|charter|fraunces|times|source serif|garamond|playfair|iowan|spectral|lora|merriweather|tiempos|canela|spectator|noto serif|dm serif|newsreader|freight)/i
const isSerif = (stack: string): boolean => SERIF_FIRST.test((stack || '').split(',')[0] || '')
const resolve = (l: DesignLanguage): ResolvedDesign => ({
  ...l,
  fonts: { ...l.fonts, displaySerif: isSerif(l.fonts.display), bodySerif: isSerif(l.fonts.body) },
})

// (1) Explicit named reference — "make it like X" / a named brand. First match wins.
const NAMED: [RegExp, string][] = [
  [/\bstripe\b/, 'stripe'],
  [/\b(linear|vercel)\b/, 'linear-graphite'],
  [/\b(notion|shadcn)\b/, 'cal-mono'],
  [/\b(claude|anthropic)\b/, 'claude-parchment'],
  [/\bopenai\b/, 'openai-signal'],
  [/\b(ibm|carbon design)\b/, 'ibm-carbon'],
  [/\bcoinbase\b/, 'coinbase-blue'],
  [/\b(ferrari|lamborghini|bugatti|porsche|hypercar|couture|haute)\b/, 'bugatti-noir'],
  [/\bnike\b/, 'nike-podium'],
  [/\bduolingo\b/, 'duolingo-play'],
  [/\bstarbucks\b/, 'starbucks'],
  [/\bmistral\b/, 'mistral-golden'],
  [/\breplicate\b/, 'replicate'],
  [/\bcomposio\b/, 'composio-terminal'],
  [/\b(grafana|mission ?control)\b/, 'mission-control'],
]

// (2) Explicit style adjective the user asked for.
const ADJ: [RegExp, string][] = [
  [/\b(minimal|minimalist|clean|simple|understated|uncluttered)\b/, 'cal-mono'],
  [/\b(luxury|luxe|premium|elegant|high.?end|sophisticated|opulent|couture)\b/, 'bugatti-noir'],
  [/\b(brutalist|brutalism|monumental|stencil)\b/, 'nike-podium'],
  [/\b(poster|billboard|festival|zine)\b/, 'replicate'],
  [/\b(playful|fun|friendly|gamified|whimsical|cheerful)\b/, 'duolingo-play'],
  [/\b(editorial|literary|book|magazine|print|whitepaper|r[eé]sum[eé])\b/, 'kami-editorial'],
  [/\b(serif)\b/, 'claude-parchment'],
  [/\b(corporate|enterprise|formal|institutional|governance)\b/, 'ibm-carbon'],
  [/\b(warm|cozy|organic|inviting|artisan)\b/, 'starbucks'],
  [/\b(terminal|hacker|command.?line|monospace|mono)\b/, 'composio-terminal'],
  [/\b(technical|developer|dev|dark ?mode|dark ?theme|midnight)\b/, 'linear-graphite'],
  [/\b(dashboard|telemetry|monitoring|status board)\b/, 'mission-control'],
  [/\b(bold|punchy|loud|striking|vibrant|gradient|colou?rful|creative)\b/, 'replicate'],
  [/\b(athletic|sport|streetwear|campaign)\b/, 'nike-podium'],
  [/\b(calm|research|scholarly|thought.?leadership)\b/, 'openai-signal'],
]

// (4) Kind fallback when nothing else matched.
const KIND_DEFAULT: Record<string, string> = { deck: 'stripe', doc: 'kami-editorial', email: 'stripe', sheet: 'ibm-carbon' }

// Formal, high-stakes docs/sheets must NEVER resolve to a loud/luxury/gradient look.
const FORMAL = /\b(contract|agreement|nda|terms|policy|financial statement|balance sheet|income statement|audit|invoice|legal|memorandum of law|compliance|filing|10-?k|p&l)\b/
const LOUD = new Set(['replicate', 'duolingo-play', 'nike-podium', 'bugatti-noir', 'mistral-golden', 'composio-terminal', 'mission-control'])

/**
 * Resolve ONE design language for a studio request. Precedence: explicit named
 * reference -> explicit style adjective -> domain keyword score -> kind default ->
 * global default. `hint` is an optional explicit style the caller already knows.
 */
export function pickDesign(prompt: string, kind = 'deck', hint = ''): ResolvedDesign {
  const text = `${hint || ''} ${prompt || ''}`.toLowerCase()
  let id = ''
  for (const [re, v] of NAMED) if (re.test(text)) { id = v; break }
  if (!id) for (const [re, v] of ADJ) if (re.test(text)) { id = v; break }
  if (!id) {
    let best = '', bestScore = 0
    for (const L of LANGUAGES) {
      let sc = 0
      for (const k of L.keywords) if (text.includes(k)) sc += k.length >= 5 ? 2 : 1
      if (sc > bestScore) { bestScore = sc; best = L.id }
    }
    if (bestScore > 0) id = best
  }
  if (!id) id = KIND_DEFAULT[kind] || DEFAULT_ID
  if ((kind === 'doc' || kind === 'sheet') && FORMAL.test(text) && LOUD.has(id)) {
    id = kind === 'sheet' ? 'ibm-carbon' : 'kami-editorial'
  }
  return resolve(get(id))
}

/** The render-only slice to ship on a generator's JSON payload (keeps it lean). */
export function designPayload(d: ResolvedDesign) {
  return { id: d.id, name: d.name, light: d.light, dark: d.dark, fonts: d.fonts, radius: d.radius, motif: d.motif }
}

/** Re-resolve a language by id (null id / unknown falls back to default) — used to
 *  KEEP the same design across a revision so an edit never restyles the whole artifact. */
export function designById(id?: string): ResolvedDesign | null {
  if (!id || !BY_ID.has(id)) return null
  return resolve(get(id))
}

// Content-only craft for the JSON generators (slides/doc). The full CRAFT_BLOCK is
// CSS/render guidance the client Card owns; a JSON-emitting model only needs the
// CONTENT rules — folding the whole block in just bloats the prompt and adds failure
// surface. Kept short and imperative.
const CONTENT_CRAFT =
  ` Content rules: use ONLY real, specific, internally-consistent numbers, names and dates — never invented metrics ("10x faster", "99.9% uptime") and never lorem/filler ("feature one/two/three"); no emoji or decorative symbols anywhere; make each unit ONE clear point with tight hierarchy (a message headline + a few crisp lines, not a wall of text); keep ~80% proven structure plus the one distinctive move named above so it is unmistakably this language.`

/** Prompt injection so the model writes COPY + picks image scenes that fit the language.
 *  Identity + voice + art-direction + layout variety (NOT the render CSS — the Card owns that). */
export function designDirective(d: ResolvedDesign, kind = 'deck'): string {
  const layouts = kind === 'doc' ? DOC_LAYOUTS : kind === 'email' ? EMAIL_LAYOUTS : DECK_LAYOUTS
  const unit = kind === 'deck' ? 'slide' : kind === 'email' ? 'block' : 'section'
  return (
    `\n\nDESIGN LANGUAGE — "${d.name}": ${d.vibe}\n` +
    `Write EVERY line of copy and choose EVERY image/photo scene to fit this world and voice: ${d.whenToUse}. ` +
    `Its signature character is: ${d.motif}. ` +
    `Vary ${unit} layouts across these archetypes so it never reads as one repeated template: ${layouts}.` +
    CONTENT_CRAFT
  )
}
