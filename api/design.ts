// Nalu Studio — Vercel Node serverless function (extends "Nalu Design").
//
// One endpoint, many artifact kinds. Switches on body.kind:
//   webpage | poster  -> ONE self-contained HTML document (existing behavior).
//   canvas            -> Fabric.js-native scene JSON (editable vector canvas).
//   palette           -> color palette (HEX-only; client computes rgb/hsl/contrast).
//   brand             -> full brand-guideline object.
//   blueprint         -> small unit-grid technical-drawing scene.
//
// The client (Workspace intent helpers) decides the kind and sends it explicitly;
// the server never guesses. No new serverless function is added — this keeps the
// project under the hard 12-function Vercel Hobby cap. Decks stay on api/slides.ts.

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_BASE = (
  env('GLM_BASE_URL') || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
).replace(/\/+$/, '')
const LLM_KEY = env('GLM_API_KEY') || ''
const LLM_MODEL = env('NALU_DESIGN_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

type DesignKind = 'webpage' | 'poster' | 'canvas' | 'palette' | 'brand' | 'blueprint' | 'logo' | 'shopping' | 'motion'

// HTML-bearing kinds go through cleanHtml + the design-system layer.
const HTML_KINDS: ReadonlySet<DesignKind> = new Set<DesignKind>(['webpage', 'poster', 'motion'])

function normalizeKind(raw: unknown): DesignKind {
  const k = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (
    k === 'webpage' ||
    k === 'poster' ||
    k === 'canvas' ||
    k === 'palette' ||
    k === 'brand' ||
    k === 'blueprint' ||
    k === 'logo' ||
    k === 'shopping' ||
    k === 'motion'
  ) {
    return k
  }
  return 'webpage'
}

// ---------------------------------------------------------------------------
// System prompts — one per kind. HTML kinds keep today's prompt verbatim.
// ---------------------------------------------------------------------------

// The Nalu house aesthetic — the BASELINE for every generated design. Quiet,
// timeless luxury in the spirit of Four Seasons and Hillpointe.
const LUXE_BASELINE = `NALU DESIGN BASELINE — quiet, timeless luxury (think Four Seasons, Hillpointe), unless the user explicitly asks for another style:
- Restraint over decoration. Generous, intentional whitespace; a calm, confident composition; never busy or loud.
- Palette: deep, sophisticated darks (midnight navy / charcoal / ink), warm neutrals (linen, ivory, stone), and ONE muted metallic accent (soft gold / bronze ~#AF8C56) used sparingly for hairlines, small labels and key moments. Avoid bright, neon or saturated colors.
- Typography: an elegant high-contrast display serif (e.g. Cormorant Garamond, Playfair Display, Fraunces) for headlines at a refined LIGHT weight, paired with a quiet sans (e.g. Jost, Inter, Work Sans) for body. Use UPPERCASE, widely letter-spaced (0.2–0.3em) small labels. Mix in occasional italic-serif emphasis.
- Thin hairline rules, refined detailing, real specific copy — never lorem ipsum, never a stale year (use 2026 if needed).`

const SYSTEM_HTML = `You are an award-winning front-end designer & engineer (Awwwards / FWA caliber). Output ONE complete, self-contained, downloadable .html website that implements the request — a full multi-section site, landing page, web app UI, dashboard, or interactive component.

${LUXE_BASELINE}

Output ONLY the raw HTML — start with <!doctype html> and end with </html>. No markdown fences, no explanation.

BUILD A COMPLETE, POLISHED WEBSITE (not a single hero):
- A real multi-section page: sticky nav, a striking hero, then 5–9 substantive sections (features, how-it-works, gallery/showcase, stats, testimonials, pricing, FAQ, CTA, rich footer). Real, specific copy — never lorem ipsum.

NAVIGATION — get this exactly right (these are common failures):
- ONE responsive nav bar. On DESKTOP: a single horizontal row — brand left, links right (smooth-scroll anchors). On MOBILE: links collapse into a hamburger that toggles a menu.
- The hamburger MUST be hidden on desktop, and the desktop links MUST be hidden on mobile — use a media query so EXACTLY ONE is visible at any width. NEVER show both, and never leave a vertical stack of links floating on desktop.
- LEGIBILITY IS MANDATORY: the nav must have a SEMI-OPAQUE on-brand background — e.g. the deep navy at ~80% opacity (rgba(15,27,45,0.82)) WITH backdrop-blur — it must NOT be fully transparent. Nav text/links must be a LIGHT color (near-white / soft gold) with strong contrast against that navy glass, readable over ANY hero image, with a clear hover state. Test: the links must be obviously readable on top of a bright photo.
- The brand/logo in the nav must be a TEXT wordmark or INLINE SVG — NEVER an <img> tag for the logo (it can fail and show a broken-image icon). Likewise never use an <img> for icons; use inline SVG.

MOBILE-FRIENDLY IS MANDATORY — the site must look great and work perfectly on a phone:
- Include <meta name="viewport" content="width=device-width, initial-scale=1">. Build mobile-first; verify it at 375px wide AND 1440px wide.
- NO horizontal scroll ever. Multi-column grids collapse to one column on small screens. Use fluid type (clamp()), generous tap targets (≥44px), and images that scale (max-width:100%, height:auto).
- The hamburger menu must work on mobile; large hero text must shrink to fit. Padding/margins reduce on small screens.

IMAGES — they MUST always load (no broken images, ever). This is critical:
- PRIMARY source = Picsum (rock-solid, instant, real photography, no key): https://picsum.photos/seed/<unique-word-or-number>/<W>/<H>  — deterministic per seed. Use a different seed per image. Sizes: hero 1600/900, cards 800/600, avatars 200/200.
- EVERY <img> MUST be bullet-proof: include width + height (or aspect-ratio), object-fit:cover, loading="lazy", a CSS background-color placeholder (a brand tone) so it never looks empty, AND an onerror that swaps to another Picsum seed so a single failure can never show a broken icon:  onerror="this.onerror=null;this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*9999)+'/'+this.width+'/'+this.height'"
- OPTIONAL topical AI images: you MAY use Pollinations for a hero or feature where a specific subject really matters — https://image.pollinations.ai/prompt/<URL-ENCODED-DESC>?width=1280&height=720&nologo=true&seed=<n>  — but ONLY if you ALSO give it the Picsum onerror fallback above. Do NOT use model=flux (slow). Use at most 1–2 Pollinations images; everything else uses Picsum so the page is reliable and fast.
- Total images ≤ 6. The page must look complete and load fast on first paint.

ANIMATION & POLISH (tasteful, performant — never gaudy):
- Scroll-reveal: use an IntersectionObserver in vanilla JS to add an "in" class that fades/translates sections in as they enter the viewport (define the transitions in CSS). Stagger children.
- Smooth micro-interactions: hover lifts on cards/buttons, animated underlines, a subtle gradient or parallax in the hero, a sticky nav that condenses on scroll, smooth-scroll for anchor links.
- Respect prefers-reduced-motion. Keep 60fps (transform/opacity only).

TECH: everything inline (CSS in <style>, JS in <script>). You MAY use CDNs: Tailwind (https://cdn.tailwindcss.com), Google Fonts, and optionally a lightweight animation lib via CDN (AOS or GSAP) — but vanilla IntersectionObserver is preferred and dependency-free. Inline SVG for icons/logos. The file must work standalone when downloaded and opened.
Make it genuinely impressive, complete, and shippable.`

// ── Design systems ───────────────────────────────────────────────────────────
// A curated library of authentic design systems (open-design style). When the
// request names or implies one, we inject its rules so the output is a faithful
// execution of that system, not a generic site.
const DESIGN_SYSTEMS: { key: string; match: RegExp; spec: string }[] = [
  { key: 'swiss', match: /\b(swiss|international typographic|grid system|m[üu]ller-?brockmann)\b/i,
    spec: 'SWISS / INTERNATIONAL TYPOGRAPHIC STYLE: strict mathematical grid; Helvetica/Neue Haas/Inter; flush-left, ragged-right; bold objective headlines; generous whitespace; red/black/white + one accent; asymmetric balance; photography over illustration; NO decoration, no gradients, no shadows.' },
  { key: 'brutalist', match: /\b(brutalis[mt]|neo-?brutalis[mt]|raw html)\b/i,
    spec: 'NEO-BRUTALISM: raw, high-contrast, intentionally "undesigned"; thick 2–4px black borders; hard offset box-shadows (e.g. 6px 6px 0 #000); flat saturated blocks (electric yellow/blue/pink); system or monospace type, oversized; visible structure; no soft shadows, no rounded-everything; playful, bold, slightly chaotic but deliberate.' },
  { key: 'editorial', match: /\b(editorial|magazine|newspaper|journal|long-?form)\b/i,
    spec: 'EDITORIAL / MAGAZINE: high-contrast serif display (Playfair/Fraunces) with a clean sans for body; multi-column text flow; drop caps; pull-quotes; hairline rules; large captioned imagery; refined baseline rhythm; a single restrained accent.' },
  { key: 'glass', match: /\b(glass-?morph|glassmorphism|frosted glass|aero)\b/i,
    spec: 'GLASSMORPHISM: frosted translucent panels (backdrop-filter: blur), subtle 1px light borders, soft inner/outer glows over a vivid blurred gradient background; layered depth; light text on glass; restrained, modern, premium — not noisy.' },
  { key: 'bauhaus', match: /\b(bauhaus|constructivis[mt]|de stijl|geometric abstraction)\b/i,
    spec: 'BAUHAUS: primary colors (red/yellow/blue) + black on off-white; pure geometric shapes (circles, triangles, rectangles) as composition; bold geometric sans; diagonal energy; functional, balanced, playful-rational.' },
  { key: 'memphis', match: /\b(memphis|80s|eighties|postmodern pattern)\b/i,
    spec: 'MEMPHIS / 80s POSTMODERN: clashing bright colors, squiggles, zigzags, confetti shapes, polka dots, terrazzo; playful asymmetry; chunky shapes; fun and energetic but composed.' },
  { key: 'y2k', match: /\b(y2k|vaporwave|retro-?futuris[mt]|2000s|chrome aesthetic|frutiger)\b/i,
    spec: 'Y2K / VAPORWAVE: chrome/metallic gradients, glossy bevels, lens flares, gridded horizons, magenta–cyan palettes, pixel or wide-tracked techno type; nostalgic early-2000s digital sheen.' },
  { key: 'minimal', match: /\b(minimal(is[mt])?|clean|understated|spacious)\b/i,
    spec: 'MINIMALISM: maximum whitespace, a tiny type scale of 2 sizes, one neutral palette + one accent, no decoration, generous line-height, content-first; every element earns its place.' },
  { key: 'luxury', match: /\b(luxur(y|ious)|high-?end|elegant|premium|boutique|couture)\b/i,
    spec: 'QUIET LUXURY: deep ink/charcoal + warm neutrals + a single muted gold (#AF8C56) hairline accent; light-weight high-contrast serif display (Cormorant/Fraunces) + quiet sans; widely letter-spaced uppercase labels; restraint, air, refined detailing.' },
  { key: 'corporate', match: /\b(corporate|saas|enterprise|b2b|dashboard ui|fintech)\b/i,
    spec: 'MODERN SAAS: clean Inter/Geist sans; an 8pt spacing system; a calm blue/indigo primary with neutral grays; soft 1px borders + subtle shadows; rounded-xl cards; clear hierarchy; trustworthy, crisp, accessible.' },
  { key: 'organic', match: /\b(organic|hand-?drawn|playful|whimsical|illustrative|friendly)\b/i,
    spec: 'ORGANIC / HAND-CRAFTED: soft blob shapes, gentle curves, hand-drawn SVG accents, warm earthy palette, rounded friendly sans, slight imperfection; approachable and human.' },
  { key: 'dark', match: /\b(dark mode|neon|cyber(punk)?|tech noir|terminal)\b/i,
    spec: 'DARK / NEON TECH: near-black canvas, neon accent (cyan/violet/lime), subtle glow on key elements, monospace accents, grid/scanline texture, high contrast; sleek and futuristic without being unreadable.' },
]
function detectSystem(prompt: string, explicit?: string): { key: string; spec: string } | null {
  if (explicit) { const m = DESIGN_SYSTEMS.find((d) => d.key === explicit.toLowerCase()); if (m) return m }
  for (const d of DESIGN_SYSTEMS) if (d.match.test(prompt)) return d
  return null
}
function designSystemHint(prompt: string, kind: DesignKind, explicit?: string): string {
  if (!HTML_KINDS.has(kind) && kind !== 'canvas') return ''
  const sys = detectSystem(prompt, explicit)
  if (!sys) return ''
  return `\n\nDESIGN SYSTEM — execute this faithfully and authentically (it OVERRIDES the default house style; honor any specific colors/brand the user named):\n${sys.spec}`
}

const SYSTEM_MOTION = `You are a motion designer & creative coder. Output ONE complete, self-contained, LOOPING animated HTML motion graphic (a "HyperFrame") that implements the request — e.g. an animated logo reveal, kinetic typography, an animated promo / hero / title card, a product teaser, an animated poster, or a looping ambient background.

REQUIREMENTS:
- ONE self-contained .html: inline <style> + optional <script>. NO external libraries and NO network <img> — draw everything with CSS, inline SVG, or <canvas>. Google Fonts via <link> are allowed for TYPE only. It must run offline.
- It MUST start animating immediately on load and LOOP seamlessly and forever (CSS @keyframes ... infinite, or a requestAnimationFrame canvas/SVG loop). No clicks or hovers required.
- Full-bleed 16:9 stage that fills the frame (100vw/100vh or a centered fixed-aspect stage / responsive canvas, dark or on-brand background). Premium composition: strong focal point, depth/layering, eased timing (cubic-bezier), staggered reveals, tasteful motion — not a single thing blinking.
- Use the REAL, specific copy from the request (never lorem ipsum). Crisp, intentional typography.
- 60fps: animate transform / opacity / filter only (GPU-friendly); never animate layout properties.

Output ONLY the complete HTML document — no markdown fences, no <think>, no commentary — starting with <!doctype html>.`

const SYSTEM_CANVAS = `You are a world-class graphic designer. You seed an EDITABLE vector canvas (Fabric.js) for the user to tweak in-page.
Design the requested artifact (social post, flyer, poster, story, graphic) with strong composition, hierarchy, and real copy.

${LUXE_BASELINE}

Output ONLY one minified JSON object — no markdown fences, no <think>, no prose — of this exact shape:
{"canvas":{"width":1080,"height":1350,"background":"#0B1020","objects":[ ... ]}}

Object rules (each object is one Fabric.js object):
- "type" is one of: "rect","circle","ellipse","triangle","line","polygon","path","textbox".
- Position with "left" and "top" = the TOP-LEFT corner in pixels (NOT centered).
- Sizes: rect/textbox use "width"/"height"; circle uses "radius"; ellipse uses "rx"/"ry"; line uses "x1","y1","x2","y2"; polygon uses "points":[{"x":..,"y":..}].
- "fill" is a hex string OR a gradient {"type":"linear","coords":{"x1":..,"y1":..,"x2":..,"y2":..},"colorStops":[{"offset":0,"color":"#.."},{"offset":1,"color":"#.."}]}.
- A "textbox" also has: "text" (REAL copy, never lorem ipsum), "fontSize", "fontWeight" (e.g. 400/600/700), "fontFamily" (use "Inter" or "Arial"), "fill", "textAlign", and optional "lineHeight"/"charSpacing".
- Choose a width/height that fits the request (1080x1350 portrait, 1080x1080 square, 1080x1920 story, 1200x630 OG, etc.).
- Keep EVERY object fully inside the canvas bounds. Layer back-to-front (background shapes first, text last).
- Use a cohesive, modern palette and tasteful spacing. Aim for ~8–20 objects. Output ONLY the JSON object.`

const SYSTEM_LOGO = `You art-direct a logo. Nalu's design engine RENDERS the vector art in code (crisp wordmarks + geometric monograms), so you do NOT draw SVG — you only return the brand direction as compact JSON.

- "name": the brand name EXACTLY as the user gives it — verbatim, unchanged. NEVER invent, translate, expand, or append words ("Acme" stays "Acme", never "Acme Get"). If the request gives no explicit name, choose ONE clean, real-sounding 1–2 word name (never a phrase or random words).
- "initials": 1–2 uppercase letters for the monogram — two-word names → first letter of each; one-word names → just the first letter.
- "serif": true if the brand should feel classic / elegant / luxury / editorial / heritage; false for modern / tech / clean / minimal / startup.
- "colors": ["#primary","#accent"] — a refined, professional palette (deep, confident, timeless; no neon, no more than 2).
- "concept": a ≤6-word vibe label.

Output ONLY this minified JSON — no markdown, no <think>, no SVG, no prose:
{"name":"Acme","initials":"A","serif":false,"colors":["#0F1B2D","#AF8C56"],"concept":"modern geometric"}`

const SYSTEM_SHOPPING = `You are an expert interior designer & personal shopper. Build a CURATED, real-world shopping list for the user's request (a room, a whole house, an outfit, a setup — anything they want to buy).

Be genuinely useful and specific, like a great designer who shops for a living:
- Pick REAL, recognizable products and well-known retailers (IKEA, Article, West Elm, CB2, Wayfair, Crate & Barrel, Pottery Barn, Amazon, Target, Home Depot, Lowe's, Floyd, Burrow, AllModern, Rejuvenation, etc.). Use realistic current-market PRICES.
- Cover everything needed so the result feels complete and cohesive — furniture, lighting, rugs, textiles, storage, decor, plants — grouped by category. Aim for 8–16 items.
- Each item: a concrete product name, the category, a one-line reason it was chosen / what to look for, a realistic price (or tight range), and a suggested retailer. Add a short "query" = the exact words to search to find it (the app builds the store links from this — do NOT write URLs).
- Keep a coherent style and a sensible total. If the user gave a budget, respect it and note the running total.

Output ONLY one minified JSON object — no markdown fences, no <think>, no prose:
{"title":"Modern Living Room","summary":"one short line on the look & vibe","budget":"~$4,200 total","items":[{"name":"Sven 88\\" Sofa","category":"Seating","reason":"low-profile mid-century sofa, durable boucle","price":"$1,399","retailer":"Article","query":"Article Sven 88 sofa boucle"}]}

Rules: every item MUST have name, category, price, and query. Keep names real and searchable. 8–16 items. No emojis.`

const SYSTEM_PALETTE = `You are a world-class brand colorist. Build a cohesive, accessible color palette for the request.

Output ONLY one minified JSON object — no markdown fences, no <think>, no prose — of this exact shape:
{"name":"Palette Name","description":"one short mood line","colors":[{"role":"primary","name":"Deep Ocean","hex":"#0B3D5C","usage":"headers, primary buttons"}]}

Rules:
- 5 to 8 colors. "role" is one of: "primary","secondary","accent","neutral","background","surface","success","warning","danger".
- "hex" MUST be a valid 6-digit hex like "#0B3D5C". Give EVERY color a hex — do NOT output rgb/hsl, the client computes those.
- "name" is an evocative color name; "usage" is a short note on where to use it.
- Ensure the set is harmonious and includes enough contrast for readable text. Output ONLY the JSON object.`

const SYSTEM_BRAND = `You are an award-winning brand strategist and designer (Pentagram / Collins caliber). You produce ONLY the STRUCTURED CONTENT for a brand guidelines book — never HTML, never CSS, never layout. A fixed, hand-crafted template renders your JSON into a polished multi-page book, so your sole job is rich, specific, real editorial CONTENT.

Output ONLY one minified JSON object — no markdown fences, no <think>, no prose, no comments — of EXACTLY this shape:

{"brand":{"name":"","tagline":"","mission":"","vision":"","positioning":"","values":[{"label":"","description":""}],"voice":[{"label":"","description":""}]},"palette":[{"role":"primary","name":"","hex":"#RRGGBB","usage":""}],"typography":{"heading":{"family":"","usage":""},"body":{"family":"","usage":""},"scale":["Display","Heading 1","Heading 2","Heading 3","Body","Caption"]},"logo":{"direction":"","clearspace":"","minSize":""},"dos":[""],"donts":[""]}

DEFAULT SUBJECT: If the user does not name a specific company, the brand is Nalu — a modern AI company at n4lu.ai. "Nalu" means "wave" in Hawaiian; the theme is oceanic, calm, intelligent and premium. NEVER invent an unrelated company name; never substitute another company.

CONTENT RULES:
- Real, specific, confident copy — NEVER lorem ipsum or placeholder text. If you reference a year, use 2026 (never 2024).
- brand.tagline: one short, memorable line. brand.mission / vision / positioning: one to two crisp sentences each, distinct from one another (mission = why we exist now; vision = the future we're building; positioning = who we serve and why we're the only choice).
- brand.values: 4 to 6 entries. Each "label" is 1–2 words; each "description" is ONE directive line. Do NOT repeat the label inside the description and do NOT glue label+description with a dash, colon, or en/em dash — they are separate JSON fields.
- brand.voice: 3 to 5 entries. Each "label" is a single voice trait (e.g. "Clear", "Warm", "Confident"); each "description" is ONE line on how it shows up in writing. Same field-separation rule as values.
- palette: 5 to 6 colors. "role" MUST be drawn from: primary, secondary, accent, dark, light, neutral — include exactly one primary, one secondary, one accent, one dark (for text), and one light (for backgrounds). Every "hex" MUST be a valid 6-digit #RRGGBB (the template computes RGB and CMYK from it — do NOT supply them). Give each color an evocative "name" and a directive one-line "usage" note. Ensure the dark color reads as body text on the light color, and the light color works as a page background. AESTHETIC TARGET — quiet, timeless luxury in the spirit of Four Seasons and Hillpointe: restrained, refined, expensive-feeling, NOT loud or saturated. For Nalu, design a sophisticated palette: a deep midnight-navy primary (around #0F1B2D), a deep harbor-blue secondary, ONE muted gold/bronze accent (around #AF8C56) used sparingly for hairlines and labels, a near-black ink, and a warm linen/ivory light (around #F4F1EA). Avoid bright or neon colors entirely.
- typography: pick exactly TWO real Google Fonts that exist in the Google Fonts library — for heading, an ELEGANT high-contrast display serif suited to quiet luxury (prefer Cormorant Garamond, Playfair Display, or Fraunces); for body, a refined, understated sans (prefer Jost, Inter, or Work Sans). Use the EXACT Google Fonts family name (correct spelling and capitalization) so the font URL resolves. Heading and body MUST be different families. "usage" on each says where it is used. "scale" is exactly 6 labels from Display down to Caption.
- logo.direction: describe the primary lockup in words (wordmark style + the wave motif), 1–2 sentences. logo.clearspace: a concrete rule (e.g. "Clear space equals the cap-height of the wordmark on all sides"). logo.minSize: concrete digital + print minimums (e.g. "24px digital · 12mm print").
- dos: 4 to 6 short directive lines of correct usage across the system. donts: 4 to 6 short lines of misuse to avoid. Keep them parallel where possible (the template pairs the first four as we-say / we-don't and lists all as a do/don't table).
- Be defensive about completeness: fill EVERY field with real content so no panel renders empty. Output ONLY the JSON object.`

const SYSTEM_BLUEPRINT = `You are a master architect producing a precise, EXHAUSTIVELY detailed, professional set of drawings (multi-floor plans + an optional site plan). Draftsmanship must rival real CAD: accurate to-scale proportions, dense dimensioning, every fixture and material called out, clear labels.

Output ONLY one minified JSON object — no markdown fences, no <think>, no prose — of this exact shape. Provide a "floors" array (one entry per level / site sheet); each floor shares the top-level "units"/"scale"/"grid" and has its own viewBox + shapes + dimensions + annotations:
{"title":"Grand Estate — Construction Set","units":"ft","scale":"1/8\\" = 1'","grid":{"step":2,"show":true},
"floors":[
 {"name":"Site Plan","viewBox":{"w":120,"h":90},"shapes":[{"type":"rect","x":0,"y":0,"w":120,"h":90,"label":"Property line","stroke":1},{"type":"rect","x":35,"y":30,"w":50,"h":40,"label":"Residence","stroke":3},{"type":"ellipse","cx":95,"cy":60,"rx":12,"ry":7,"label":"Pool"},{"type":"rect","x":5,"y":70,"w":24,"h":12,"label":"Parking (3 cars)"},{"type":"line","x1":17,"y1":70,"x2":17,"y2":82},{"type":"line","x1":25,"y1":70,"x2":25,"y2":82},{"type":"polyline","points":[[14,90],[14,78],[35,70]],"stroke":2},{"type":"tree","cx":12,"cy":20,"r":4,"label":"Oak"},{"type":"tree","cx":108,"cy":18,"r":3},{"type":"rect","x":35,"y":74,"w":30,"h":10,"label":"Lawn / landscaping"},{"type":"text","x":50,"y":50,"text":"RESIDENCE"}],"dimensions":[{"x1":0,"y1":-2,"x2":120,"y2":-2,"text":"120'-0\\"","side":"top"}],"annotations":[{"x":95,"y":60,"text":"30' × 16' pool, gunite","leaderTo":[90,60]}]},
 {"name":"Ground Floor","viewBox":{"w":50,"h":40},"shapes":[{"type":"rect","x":0,"y":0,"w":50,"h":40,"label":"Exterior wall","stroke":3},{"type":"rect","x":1,"y":1,"w":22,"h":18,"label":"Great Room"},{"type":"door","x":24,"y":10,"w":3,"swing":"left"},{"type":"window","x":6,"y":0,"w":6},{"type":"rect","x":24,"y":1,"w":15,"h":12,"label":"Kitchen"},{"type":"rect","x":25,"y":2,"w":6,"h":2,"label":"Marble island"},{"type":"rect","x":36,"y":2,"w":3,"h":3,"label":"Fridge"},{"type":"rect","x":31,"y":2,"w":3,"h":2,"label":"Range"},{"type":"text","x":10,"y":10,"text":"GREAT ROOM"}],"dimensions":[{"x1":0,"y1":-2,"x2":50,"y2":-2,"text":"50'-0\\"","side":"top"}],"annotations":[{"x":28,"y":3,"text":"Calacatta marble countertop","leaderTo":[28,4]}]}
]}

Rules — follow REAL architectural floor-plan conventions exactly:
- ALL coordinates are in grid UNITS (feet), NOT pixels. Keep each viewBox sensible (site up to ~120–160; building floors ~28–60).
- "floors": the key levels (2–4 max). House/mansion = a SITE PLAN (property line, driveway, parking stalls, pool, walkways, lawn, a few TREES) + Ground Floor + Second Floor. Apartment/condo = ONE floor (the unit). Name each floor.

ROOM LAYOUT — this is the #1 thing to get right (do NOT make the past mistakes):
- Rooms must TILE the interior: PARTITION the building footprint into ADJACENT, NON-OVERLAPPING rooms that SHARE walls. Every interior point belongs to exactly ONE room. NEVER draw a room rectangle inside another room, and never let two room rectangles overlap. Lay rooms edge-to-edge like real tiles filling the footprint.
- Draw exactly ONE exterior boundary per floor: a single rect labeled "Exterior wall" with stroke 3 (thick). Interior partitions are "line" shapes or room-rect edges (thin, stroke 1). Exterior walls thick, interior walls thin (real convention).
- Lay it out logically like a real unit: an ENTRY/foyer, then LIVING + DINING + KITCHEN (open or adjacent), BEDROOMS grouped with their BATHS, plus CLOSETS, LAUNDRY, and a BALCONY/patio for apartments. Put plumbing (kitchen + baths) near shared walls.
- Upper floors STACK on the SAME footprint as the floor below (same viewBox + same exterior outline), so the building lines up vertically. Stairs appear in the same location on each floor.
- Real dimensions: exterior walls ~0.5 ft thick, interior ~0.33 ft; doors 2.5–3 ft (draw with the door arc/swing INTO the room); standard fixtures to scale — fridge 3×3, range 2.5×2.5, sink 2×2, tub 2.5×5, shower 3×3, toilet 1.5×2.5, bed 5×6.5, island 3×6.

DETAIL — be granular (20–34 shapes per building floor):
- Label every ROOM in UPPERCASE with its size (e.g. text "LIVING 14'×18'"). Inside each room place the main FIXTURES drawn to scale and labeled (kitchen: refrigerator/range/dishwasher/sink/island; baths: toilet/tub/shower/vanity; bedrooms: bed/closet; living: sofa/fireplace; laundry: washer/dryer).
- shape types: "rect"(x,y,w,h), "line"(x1,y1,x2,y2), "circle"(cx,cy,r), "ellipse"(cx,cy,rx,ry) — pools/round tables, "polyline"(points:[[x,y]]) — driveways/walks, "text"(x,y,text), "door"(x,y,w,swing:"left"|"right"), "window"(x,y,w), "tree"(cx,cy,r). Optional "label" + integer "stroke" (1=thin interior, 3=thick exterior).
- CALL OUT MATERIALS in annotations ("Calacatta marble counter", "white oak floor", "slate patio"). 4–8 annotations per floor.
- DIMENSION GENEROUSLY: overall dims on ≥2 sides PLUS internal room dims, proper notation (12'-6", Ø2.5", R3).
- Include "scale" and a precise "title". Be geometrically consistent and to-scale. Output ONLY the JSON object.`

function getSystemPrompt(kind: DesignKind): string {
  switch (kind) {
    case 'motion':
      return SYSTEM_MOTION
    case 'webpage':
    case 'poster':
      return SYSTEM_HTML
    case 'canvas':
      return SYSTEM_CANVAS
    case 'palette':
      return SYSTEM_PALETTE
    case 'brand':
      return SYSTEM_BRAND
    case 'blueprint':
      return SYSTEM_BLUEPRINT
    case 'logo':
      return SYSTEM_LOGO
    case 'shopping':
      return SYSTEM_SHOPPING
  }
}

// Kept modest so generations finish FAST (~40–80s) and reliably — the JSON
// repair handles any truncation, so we trade a little depth for speed.
function maxTokensFor(kind: DesignKind): number {
  if (kind === 'webpage') return 8500 // full site, but bounded for speed
  if (kind === 'blueprint') return 9000 // multi-floor, bounded
  if (kind === 'canvas') return 6000
  if (kind === 'logo') return 11000 // 3 options × (mark + lockup)
  if (kind === 'shopping') return 4500 // a curated list of items
  if (kind === 'motion') return 7000 // a self-contained animated HyperFrame
  if (HTML_KINDS.has(kind)) return 6000
  return 5000
}

type BrandIn = {
  name?: string
  primary?: string
  accent?: string
  dark?: string
  text?: string
  headingFont?: string
  bodyFont?: string
}

// Inject the user's active Brand Kit so generated designs/code match the brand.
// Only color-bearing kinds (canvas/poster/webpage); palette/brand define their
// own colors and blueprints are monochrome line art.
function brandHint(raw: unknown, kind: DesignKind): string {
  if (kind !== 'canvas' && kind !== 'poster' && kind !== 'webpage' && kind !== 'brand' && kind !== 'logo') return ''
  if (!raw || typeof raw !== 'object') return ''
  const b = raw as BrandIn
  const hx = (h?: string) =>
    typeof h === 'string' && /^#?[0-9a-fA-F]{6}$/.test(h.replace(/^#/, '')) ? '#' + h.replace(/^#/, '').toUpperCase() : ''
  const primary = hx(b.primary)
  const accent = hx(b.accent)
  const dark = hx(b.dark)
  const text = hx(b.text)
  if (!primary && !accent) return ''
  const fonts = [b.headingFont && `headings "${b.headingFont}"`, b.bodyFont && `body "${b.bodyFont}"`]
    .filter(Boolean)
    .join(', ')
  return `\n\nDEFAULT BRAND KIT (use ONLY as the default — if the user's request above names any specific colors, palette, theme, or style, FOLLOW THE USER and ignore this):${
    primary ? ` primary ${primary};` : ''
  }${accent ? ` accent ${accent};` : ''}${dark ? ` dark ${dark};` : ''}${text ? ` body text ${text};` : ''}${
    fonts ? ` typography: ${fonts}.` : ''
  }`
}

// ---------------------------------------------------------------------------
// Parsers — lifted from the existing webpage path + slides.ts extractJson.
// ---------------------------------------------------------------------------

function cleanHtml(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const lower = t.toLowerCase()
  const start = lower.indexOf('<!doctype')
  const s2 = start === -1 ? lower.indexOf('<html') : start
  if (s2 > 0) t = t.slice(s2)
  return t.trim()
}

// Repair JSON that got TRUNCATED by the model's output limit (a big multi-floor
// blueprint / deep doc can be cut mid-structure). We keep the longest valid
// prefix — closing open strings/arrays/objects and dropping a dangling key — so
// a long generation still renders instead of failing entirely.
function repairJson(s: string): string {
  let inStr = false
  let esc = false
  const stack: string[] = []
  let lastSafe = 0 // index up to which we have a complete element
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') {
        inStr = false
        lastSafe = i + 1
      }
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') {
      stack.pop()
      lastSafe = i + 1
    } else if (ch === ',') lastSafe = i + 1
  }
  let out = s.slice(0, lastSafe).replace(/[\s,]+$/, '')
  // drop a dangling "key": or "key": partial-value at the end
  out = out.replace(/,?\s*"(?:\\.|[^"\\])*"\s*:\s*[^,{}[\]]*$/, '')
  out = out.replace(/[\s,]+$/, '')
  while (stack.length) out += stack.pop()
  return out
}

// Strips <think> + ```json fences, slices first { … last }, and on truncation
// repairs the JSON so deep generations still parse.
function extractJson(text: string): unknown | null {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const i = t.indexOf('{')
  if (i === -1) return null
  const j = t.lastIndexOf('}')
  if (j > i) {
    try {
      return JSON.parse(t.slice(i, j + 1))
    } catch {
      /* fall through to repair */
    }
  }
  try {
    return JSON.parse(repairJson(t.slice(i)))
  } catch {
    return null
  }
}

// Normalize an LLM-supplied color into a clean #RRGGBB hex, or null if it is
// not recoverable. The cards compute rgb/hsl/contrast from this string, so a
// malformed value (missing #, 3-digit shorthand, stray spaces) would otherwise
// render an unreadable/invalid swatch. Never trust the model's color text.
function normHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let h = raw.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return '#' + h.toUpperCase()
}

// Keep only palette entries that carry a valid hex (repairing the hex in place).
// Returns the cleaned array, or null if nothing usable survives.
function cleanPalette(raw: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw)) return null
  const out: Array<Record<string, unknown>> = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const entry = c as Record<string, unknown>
    const hex = normHex(entry.hex)
    if (!hex) continue
    out.push({ ...entry, hex })
  }
  return out.length ? out : null
}

// Per-kind shape validation. Returns the response payload (already carrying
// kind + name) or null if the parse/shape is unusable (handler 502s).
function buildJsonPayload(
  kind: DesignKind,
  content: string,
): Record<string, unknown> | null {
  const parsed = extractJson(content)
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>

  switch (kind) {
    case 'canvas': {
      const canvas = p.canvas as { objects?: unknown } | undefined
      if (!canvas || typeof canvas !== 'object' || !Array.isArray(canvas.objects)) {
        return null
      }
      if (canvas.objects.length === 0) return null
      return { kind, name: 'Nalu Studio', canvas }
    }
    case 'palette': {
      const colors = cleanPalette(p.colors)
      if (!colors) return null
      return {
        kind,
        name: typeof p.name === 'string' && p.name ? p.name : 'Nalu Studio',
        description: typeof p.description === 'string' ? p.description : '',
        colors,
      }
    }
    case 'logo': {
      // New: the model returns only brand DIRECTION; the client renders the
      // actual vector logos in code. We just validate/normalize the fields.
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
      const name = str(p.name) || 'Brand'
      let initials = str(p.initials).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2)
      if (!initials) {
        const w = name.split(/\s+/).filter(Boolean)
        initials = (w.length >= 2 ? w[0][0] + w[1][0] : name.slice(0, 1)).toUpperCase()
      }
      const colors = Array.isArray(p.colors)
        ? (p.colors as unknown[]).filter((c) => typeof c === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(c)).map((c) => c as string).slice(0, 4)
        : []
      return {
        kind,
        name,
        initials,
        serif: !!p.serif,
        colors,
        concept: str(p.concept),
      }
    }
    case 'brand': {
      if (!p.brand || typeof p.brand !== 'object') return null
      const palette = cleanPalette(p.palette)
      if (!palette) return null
      return {
        kind,
        name: 'Nalu Studio',
        brand: p.brand,
        palette,
        typography: p.typography ?? {},
        logo: p.logo ?? {},
        dos: Array.isArray(p.dos) ? p.dos : [],
        donts: Array.isArray(p.donts) ? p.donts : [],
        spacing: p.spacing ?? {},
      }
    }
    case 'blueprint': {
      // New form: a "floors" array (multi-level). Legacy: a single shapes/viewBox.
      const floors = Array.isArray(p.floors)
        ? (p.floors as Array<Record<string, unknown>>).filter(
            (f) => f && Array.isArray(f.shapes) && f.shapes.length && f.viewBox && typeof f.viewBox === 'object',
          )
        : []
      const hasLegacy = Array.isArray(p.shapes) && p.shapes.length && p.viewBox && typeof p.viewBox === 'object'
      if (!floors.length && !hasLegacy) return null
      return {
        kind,
        name: 'Nalu Studio',
        title: typeof p.title === 'string' ? p.title : 'Blueprint',
        units: typeof p.units === 'string' ? p.units : '',
        scale: typeof p.scale === 'string' ? p.scale : '',
        grid: p.grid ?? { step: 2, show: true },
        ...(floors.length
          ? { floors }
          : {
              viewBox: p.viewBox,
              shapes: p.shapes,
              dimensions: Array.isArray(p.dimensions) ? p.dimensions : [],
              annotations: Array.isArray(p.annotations) ? p.annotations : [],
            }),
      }
    }
    case 'shopping': {
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
      const rawItems = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : []
      const items = rawItems
        .filter((it) => it && typeof it === 'object' && str(it.name))
        .map((it) => ({
          name: str(it.name),
          category: str(it.category) || 'Item',
          reason: str(it.reason),
          price: str(it.price),
          retailer: str(it.retailer),
          query: str(it.query) || str(it.name),
        }))
        .slice(0, 24)
      if (!items.length) return null
      return {
        kind,
        title: str(p.title) || 'Shopping List',
        summary: str(p.summary),
        budget: str(p.budget),
        items,
      }
    }
    // HTML kinds never reach here.
    case 'webpage':
    case 'poster':
    case 'motion':
      return null
  }
}

// ---------------------------------------------------------------------------
// Brand book — a FIXED, hand-crafted multi-page template. The LLM supplies only
// structured content (SYSTEM_BRAND); this renders it into a polished book.
// ---------------------------------------------------------------------------
function buildBrandBookHtml(p: Record<string, unknown>): string {
  // ---- defensive readers -------------------------------------------------
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const str = (v: unknown, fb = ''): string =>
    typeof v === 'string' && v.trim() ? v.trim() : fb
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const strList = (v: unknown): string[] =>
    arr(v).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // ---- color math --------------------------------------------------------
  type RGB = { r: number; g: number; b: number }
  const normHex = (raw: unknown, fb = '#0B2E3F'): string => {
    if (typeof raw !== 'string') return fb
    let h = raw.trim().replace(/^#/, '')
    if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('')
    return /^[0-9a-fA-F]{6}$/.test(h) ? '#' + h.toUpperCase() : fb
  }
  const toRgb = (hex: string): RGB => {
    const h = normHex(hex).slice(1)
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }
  const luminance = ({ r, g, b }: RGB): number => {
    const lin = (c: number): number => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  // Readable on-color text (near-white / near-ink) chosen by luminance.
  const onColor = (hex: string): string => (luminance(toRgb(hex)) > 0.42 ? '#0B1418' : '#FFFFFF')
  const softOn = (hex: string): string =>
    luminance(toRgb(hex)) > 0.42 ? 'rgba(11,20,24,.62)' : 'rgba(255,255,255,.70)'
  const hairOn = (hex: string): string =>
    luminance(toRgb(hex)) > 0.42 ? 'rgba(11,20,24,.16)' : 'rgba(255,255,255,.22)'
  const cmyk = (hex: string): string => {
    const { r, g, b } = toRgb(hex)
    const R = r / 255, G = g / 255, B = b / 255
    const k = 1 - Math.max(R, G, B)
    if (k >= 0.9995) return '0 0 0 100'
    const cl = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))
    const c = cl(((1 - R - k) / (1 - k)) * 100)
    const m = cl(((1 - G - k) / (1 - k)) * 100)
    const y = cl(((1 - B - k) / (1 - k)) * 100)
    return `${c} ${m} ${y} ${cl(k * 100)}`
  }
  const rgbStr = (hex: string): string => {
    const { r, g, b } = toRgb(hex)
    return `${r} ${g} ${b}`
  }
  const mix = (hex: string, withHex: string, t: number): string => {
    const a = toRgb(hex), b = toRgb(withHex)
    const m = (x: number, y: number): number => Math.round(x + (y - x) * t)
    const h = (n: number): string => n.toString(16).padStart(2, '0')
    return '#' + h(m(a.r, b.r)) + h(m(a.g, b.g)) + h(m(a.b, b.b))
  }

  // ---- shared inline helpers (declared before use) -----------------------
  const wave = (stroke: string, opacity = 1): string =>
    `<svg class="wave" viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true" style="opacity:${opacity}"><path d="M0,60 C150,10 300,110 450,60 C600,10 750,110 900,60 C1050,10 1150,90 1200,60" fill="none" stroke="${stroke}" stroke-width="3"/><path d="M0,84 C150,34 300,134 450,84 C600,34 750,134 900,84 C1050,34 1150,114 1200,84" fill="none" stroke="${stroke}" stroke-width="2" opacity=".55"/><path d="M0,36 C150,-14 300,86 450,36 C600,-14 750,86 900,36 C1050,-14 1150,66 1200,36" fill="none" stroke="${stroke}" stroke-width="1.5" opacity=".35"/></svg>`
  const waveMark = (stroke: string): string =>
    `<svg class="mark" viewBox="0 0 64 40" aria-hidden="true"><path d="M2,28 C10,12 18,12 26,22 C34,32 42,32 50,16 C56,6 60,6 62,10" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round"/></svg>`
  const eyebrow = (num: string, label: string): string =>
    `<div class="eyebrow"><span class="eye-num">${esc(num)}</span><span class="eye-line"></span><span class="eye-label">${esc(label)}</span></div>`
  const eyebrowOn = (label: string, on: string, soft: string): string =>
    `<div class="eyebrow on"><span class="eye-line" style="background:${on}"></span><span class="eye-label" style="color:${soft}">${esc(label)}</span></div>`
  const footer = (num: string, label: string, page: string): string =>
    `<footer class="foot"><span class="foot-rule"></span><div class="foot-row"><span class="foot-brand">${esc(name)} · Brand Guidelines</span><span class="foot-mid">${esc(num)} / ${esc(label)}</span><span class="foot-pg">${esc(page)}</span></div></footer>`

  // ---- data --------------------------------------------------------------
  const brand = obj(p.brand)
  const name = str(brand.name, 'Nalu')
  const tagline = str(brand.tagline, 'Ride the wave of intelligence.')
  const mission = str(brand.mission)
  const vision = str(brand.vision)
  const positioning = str(brand.positioning)

  type LD = { label: string; desc: string }
  const pairList = (v: unknown): LD[] =>
    arr(v)
      .map((item): LD => {
        if (typeof item === 'string') {
          const parts = item.split(/[—:–-]/)
          const label = (parts[0] || item).trim()
          const desc = parts.slice(1).join(' ').trim()
          return { label, desc }
        }
        const o = obj(item)
        return { label: str(o.label || o.name, ''), desc: str(o.desc || o.description, '') }
      })
      .filter((x) => x.label)
  const values = pairList(brand.values)
  const voice = pairList(brand.voice)

  // palette
  type Swatch = { role: string; name: string; hex: string; usage: string }
  const rawPal: Swatch[] = arr(p.palette)
    .map((c): Swatch => {
      const o = obj(c)
      return {
        role: str(o.role, 'color').toLowerCase(),
        name: str(o.name, ''),
        hex: normHex(o.hex, ''),
        usage: str(o.usage, ''),
      }
    })
    .filter((c) => /^#[0-9A-F]{6}$/.test(c.hex))
  const palette: Swatch[] = rawPal.length
    ? rawPal
    : [
        { role: 'primary', name: 'Midnight Tide', hex: '#0F1B2D', usage: 'Primary surfaces, headers, full-bleed brand fields.' },
        { role: 'secondary', name: 'Deep Harbor', hex: '#1B3A53', usage: 'Supporting panels and secondary emphasis.' },
        { role: 'accent', name: 'Gilded Sand', hex: '#AF8C56', usage: 'Hairlines, labels, and key moments — used sparingly.' },
        { role: 'dark', name: 'Ink', hex: '#0F1B2D', usage: 'Body text and high-contrast type.' },
        { role: 'light', name: 'Linen', hex: '#F4F1EA', usage: 'Content backgrounds and paper surfaces.' },
      ]
  const byRole = (r: string): Swatch | undefined => palette.find((c) => c.role === r)
  const primary = (byRole('primary') || palette[0]).hex
  const secondary = (byRole('secondary') || palette[1] || palette[0]).hex
  const accent = (
    byRole('accent') ||
    palette.find((c) => c.role !== 'primary' && c.role !== 'secondary') ||
    palette[0]
  ).hex
  const ink = (byRole('dark') || palette.find((c) => luminance(toRgb(c.hex)) < 0.2) || { hex: '#0B1418' }).hex
  const paper = (byRole('light') || palette.find((c) => luminance(toRgb(c.hex)) > 0.85) || { hex: '#F4F8F8' }).hex

  // typography
  const typo = obj(p.typography)
  const tHead = obj(typo.heading)
  const tBody = obj(typo.body)
  const headFamily = str(tHead.family, 'Fraunces')
  const bodyFamily = str(tBody.family, 'Inter')
  const headUsage = str(tHead.usage, 'Display headings, section titles and editorial moments.')
  const bodyUsage = str(tBody.usage, 'Body copy, captions, UI labels and long-form reading.')
  const scaleRaw = strList(typo.scale)
  const scale = scaleRaw.length
    ? scaleRaw
    : ['Display', 'Heading 1', 'Heading 2', 'Heading 3', 'Body', 'Caption']
  // Resilient Google Fonts URL: request families WITHOUT explicit weights so the
  // link never 400s on display fonts that ship a single weight; CSS font-weight
  // then synth-bolds gracefully. Spaces -> '+', strip anything unsafe for a query.
  const gf = (fam: string): string => encodeURIComponent(fam.replace(/\s+/g, ' ').trim()).replace(/%20/g, '+')
  const fams = headFamily.toLowerCase() === bodyFamily.toLowerCase()
    ? [gf(headFamily)]
    : [gf(headFamily), gf(bodyFamily)]
  const fontLink = `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${f}`).join('&')}&display=swap`
  const headStack = `'${headFamily.replace(/'/g, '')}', Georgia, 'Times New Roman', serif`
  const bodyStack = `'${bodyFamily.replace(/'/g, '')}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`

  // logo
  const logo = obj(p.logo)
  const logoDir = str(
    logo.direction,
    `A clean wordmark set in ${headFamily}, paired with the signature wave mark. Calm, confident, oceanic.`,
  )
  const clearspace = str(logo.clearspace, 'Maintain clear space equal to the cap-height of the wordmark on all sides.')
  const minSize = str(logo.minSize, '24px digital · 12mm print')

  // dos / donts
  const dos = strList(p.dos)
  const donts = strList(p.donts)

  const year = '2026'

  // =======================================================================
  // PAGES
  // =======================================================================
  const pages: string[] = []

  // 01 COVER -- full-bleed gradient + wave (a legit tall, bleed page) -------
  {
    const on = onColor(primary)
    const grad = `linear-gradient(150deg, ${mix(primary, '#000000', 0.18)} 0%, ${primary} 45%, ${mix(primary, secondary, 0.55)} 100%)`
    pages.push(`<section class="page bleed cover" style="background:${grad};color:${on}">
      <div class="cover-glow" style="background:radial-gradient(60% 50% at 78% 18%, ${accent}33 0%, transparent 70%)"></div>
      <header class="cover-top">
        <span class="cover-mark">${waveMark(on)}<span>${esc(name)}</span></span>
        <span class="cover-ed">Edition 01 · ${year}</span>
      </header>
      <div class="cover-mid">
        <div class="cover-kicker" style="color:${softOn(primary)}">Brand Guidelines</div>
        <h1 class="cover-name">${esc(name)}</h1>
        <p class="cover-tag" style="color:${softOn(primary)}">${esc(tagline)}</p>
      </div>
      <div class="cover-wave">${wave(on, 0.9)}</div>
      <footer class="cover-foot" style="border-color:${hairOn(primary)};color:${softOn(primary)}">
        <span>n4lu.ai</span><span>The complete visual &amp; verbal system</span><span>01</span>
      </footer>
    </section>`)
  }

  // 02 CONTENTS ------------------------------------------------------------
  {
    const items: [string, string, string][] = [
      ['01', 'Brand Essence', mission || positioning || vision ? 'Mission · Vision · Positioning' : 'Foundation'],
      ['02', 'Values', `${values.length || 'Core'} guiding principles`],
      ['03', 'Logo', 'Lockup · Clear space · Misuse'],
      ['04', 'Color', `${palette.length} colors · HEX · RGB · CMYK`],
      ['05', 'Typography', `${headFamily} + ${bodyFamily}`],
      ['06', 'Voice & Tone', 'How the brand sounds'],
      ['07', 'Applications', 'The system in the world'],
      ['08', 'Contact', 'Colophon · n4lu.ai'],
    ]
    pages.push(`<section class="page contents">
      ${eyebrow('—', 'Contents')}
      <h2 class="page-title">Inside <em>this book</em></h2>
      <ol class="toc">
        ${items
          .map(
            ([n, t, s]) =>
              `<li class="toc-row"><span class="toc-n">${esc(n)}</span><span class="toc-t">${esc(t)}</span><span class="toc-dots"></span><span class="toc-s">${esc(s)}</span></li>`,
          )
          .join('')}
      </ol>
      <p class="contents-note">A living document. Every rule herein exists to keep <strong>${esc(name)}</strong> unmistakable across every surface, screen and signature.</p>
      ${footer('—', 'Contents', '02')}
    </section>`)
  }

  // 03 BRAND ESSENCE -- two-panel split, equal height ----------------------
  {
    const on = onColor(primary)
    const rows: [string, string][] = ([
      mission ? ['Mission', mission] : null,
      vision ? ['Vision', vision] : null,
      positioning ? ['Positioning', positioning] : null,
    ].filter(Boolean)) as [string, string][]
    const quote = mission || positioning || vision || tagline
    pages.push(`<section class="page split">
      <div class="split-color" style="background:${primary};color:${on}">
        <div class="split-num" style="color:${hairOn(primary)}">01</div>
        ${eyebrowOn('Essence', on, softOn(primary))}
        <blockquote class="pull" style="border-color:${hairOn(primary)}">${esc(quote)}</blockquote>
        <div class="split-wave">${wave(on, 0.7)}</div>
      </div>
      <div class="split-body">
        <h2 class="split-h">Why we <em>exist</em></h2>
        <div class="essence-list">
          ${rows
            .map(
              ([k, v]) =>
                `<div class="essence-row"><div class="essence-k" style="color:${secondary}">${esc(k)}</div><p class="essence-v">${esc(v)}</p></div>`,
            )
            .join('') || `<div class="essence-row"><p class="essence-v">${esc(tagline)}</p></div>`}
        </div>
        ${footer('01', 'Brand Essence', '03')}
      </div>
    </section>`)
  }

  // 04 VALUES -- equal-height numbered card grid ---------------------------
  if (values.length) {
    const cols = values.length <= 4 ? 2 : 3
    pages.push(`<section class="page values">
      ${eyebrow('02', 'Values')}
      <h2 class="page-title">What we <em>stand for</em></h2>
      <div class="val-grid" style="grid-template-columns:repeat(${cols},1fr)">
        ${values
          .map(
            (v, i) =>
              `<div class="val-card"><span class="val-n" style="color:${accent}">${String(i + 1).padStart(2, '0')}</span><h3 class="val-label">${esc(v.label)}</h3>${v.desc ? `<p class="val-desc">${esc(v.desc)}</p>` : ''}</div>`,
          )
          .join('')}
      </div>
      ${footer('02', 'Values', '04')}
    </section>`)
  }

  // 05 LOGO -- lockup + clearspace + misuse --------------------------------
  {
    const on = onColor(primary)
    const misuse: [string, string][] = [
      ['Stretch', 'transform:scaleX(1.5)'],
      ['Recolor', 'filter:hue-rotate(180deg) saturate(2)'],
      ['Rotate', 'transform:rotate(-12deg)'],
      ['Shadow', 'filter:drop-shadow(4px 6px 4px rgba(0,0,0,.5))'],
    ]
    pages.push(`<section class="page logo">
      ${eyebrow('03', 'Logo')}
      <h2 class="page-title">The <em>mark</em></h2>
      <p class="lead">${esc(logoDir)}</p>
      <div class="logo-grid">
        <div class="logo-cell" style="background:${primary};color:${on}">
          <div class="logo-lockup">${waveMark(on)}<span style="font-family:${headStack}">${esc(name)}</span></div>
          <span class="logo-cap" style="color:${softOn(primary)}">Primary lockup · on brand color</span>
        </div>
        <div class="logo-cell light" style="background:${paper};color:${ink}">
          <div class="clearspace">
            <span class="cs-edge cs-t"></span><span class="cs-edge cs-b"></span><span class="cs-edge cs-l"></span><span class="cs-edge cs-r"></span>
            <div class="logo-lockup small">${waveMark(primary)}<span style="font-family:${headStack};color:${ink}">${esc(name)}</span></div>
          </div>
          <span class="logo-cap" style="color:rgba(11,20,24,.55)">Clear space &amp; minimum size</span>
        </div>
      </div>
      <div class="logo-specs">
        <div class="spec"><span class="spec-k">Clear space</span><p>${esc(clearspace)}</p></div>
        <div class="spec"><span class="spec-k">Minimum size</span><p>${esc(minSize)}</p></div>
      </div>
      <div class="misuse">
        <span class="misuse-h">Never</span>
        <div class="misuse-grid">
          ${misuse
            .map(
              ([lbl, css]) =>
                `<div class="mis-cell"><div class="mis-art"><span class="mis-x">✕</span><div class="logo-lockup tiny" style="${css}">${waveMark(ink)}<span style="font-family:${headStack};color:${ink}">${esc(name)}</span></div></div><span class="mis-lbl">Don't ${esc(lbl.toLowerCase())}</span></div>`,
            )
            .join('')}
        </div>
      </div>
      ${footer('03', 'Logo', '05')}
    </section>`)
  }

  // 06 COLOR -- full-width swatch stack with specs reversed out ------------
  {
    pages.push(`<section class="page color">
      <div class="color-intro">
        ${eyebrow('04', 'Color')}
        <h2 class="page-title">The <em>palette</em></h2>
        <p class="lead">Roughly 60 / 30 / 10 — primary owns the space, secondary supports, accent ignites. Each color is specified for screen and print.</p>
      </div>
      <div class="swatch-stack">
        ${palette
          .map((c) => {
            const on = onColor(c.hex)
            const soft = softOn(c.hex)
            return `<div class="swatch" style="background:${c.hex};color:${on}">
              <div class="sw-left"><span class="sw-role" style="color:${soft}">${esc(c.role)}</span><span class="sw-name">${esc(c.name || c.role)}</span>${c.usage ? `<span class="sw-usage" style="color:${soft}">${esc(c.usage)}</span>` : ''}</div>
              <div class="sw-specs"><div class="sw-spec"><b>HEX</b><span>${esc(c.hex)}</span></div><div class="sw-spec"><b>RGB</b><span>${rgbStr(c.hex)}</span></div><div class="sw-spec"><b>CMYK</b><span>${cmyk(c.hex)}</span></div></div>
            </div>`
          })
          .join('')}
      </div>
      ${footer('04', 'Color', '06')}
    </section>`)
  }

  // 07 TYPOGRAPHY -- giant specimen + true-size ladder ---------------------
  {
    const on = onColor(secondary)
    const sizes = [72, 52, 38, 27, 19, 14]
    const ladder = scale
      .slice(0, 6)
      .map((label, i) => {
        const px = sizes[Math.min(i, sizes.length - 1)]
        const isBody = i >= 4
        const fam = isBody ? bodyStack : headStack
        const lh = isBody ? '1.5' : '1.04'
        const fw = isBody ? 400 : 600
        const sample = isBody ? 'The wave is patient; it knows the shore.' : 'Ride the wave'
        return `<div class="lad-row"><span class="lad-meta">${esc(label)} · ${px}px</span><div class="lad-spec" style="font-family:${fam};font-size:${px}px;font-weight:${fw};line-height:${lh}">${sample}</div></div>`
      })
      .join('')
    pages.push(`<section class="page split type">
      <div class="split-color" style="background:${secondary};color:${on}">
        <div class="split-num" style="color:${hairOn(secondary)}">04</div>
        ${eyebrowOn('Typography', on, softOn(secondary))}
        <div class="aa" style="font-family:${headStack}">Aa</div>
        <div class="type-pair">
          <div class="tp-row" style="border-color:${hairOn(secondary)}"><span class="tp-k" style="color:${softOn(secondary)}">Display</span><span class="tp-v" style="font-family:${headStack}">${esc(headFamily)}</span></div>
          <div class="tp-row" style="border-color:${hairOn(secondary)}"><span class="tp-k" style="color:${softOn(secondary)}">Text</span><span class="tp-v" style="font-family:${bodyStack}">${esc(bodyFamily)}</span></div>
        </div>
        <div class="alpha" style="font-family:${headStack};color:${softOn(secondary)}">ABCDEFGHIJKLM<br>NOPQRSTUVWXYZ<br>1234567890</div>
      </div>
      <div class="split-body">
        <h2 class="split-h">Type <em>system</em></h2>
        <p class="type-note"><strong style="font-family:${headStack}">${esc(headFamily)}</strong> carries display &amp; headlines — ${esc(headUsage)} <strong style="font-family:${bodyStack}">${esc(bodyFamily)}</strong> handles everything read at length — ${esc(bodyUsage)}</p>
        <div class="ladder">${ladder}</div>
        ${footer('05', 'Typography', '07')}
      </div>
    </section>`)
  }

  // 08 VOICE & TONE -- principles + we say / we don't say -------------------
  {
    const sayPairs: [string, string][] = dos.slice(0, 4).map((d, i): [string, string] => [d, donts[i] || ''])
    const vCols = voice.length <= 3 ? Math.max(voice.length, 1) : voice.length === 4 ? 2 : 3
    pages.push(`<section class="page voice">
      ${eyebrow('05', 'Voice & Tone')}
      <h2 class="page-title">How we <em>sound</em></h2>
      ${
        voice.length
          ? `<div class="voice-grid" style="grid-template-columns:repeat(${vCols},1fr)">
        ${voice
          .map(
            (v) =>
              `<div class="voice-card"><span class="voice-bar" style="background:${accent}"></span><h3 class="voice-label">${esc(v.label)}</h3>${v.desc ? `<p class="voice-desc">${esc(v.desc)}</p>` : ''}</div>`,
          )
          .join('')}
      </div>`
          : ''
      }
      ${
        sayPairs.length
          ? `<div class="say-table">
        <div class="say-head"><span class="say-do" style="color:${secondary}">We say</span><span class="say-dont" style="color:${accent}">We don't</span></div>
        ${sayPairs
          .map(
            ([a, b]) =>
              `<div class="say-row"><span class="say-cell do"><i style="color:${secondary}">✓</i>${esc(a)}</span><span class="say-cell dont"><i style="color:${accent}">✕</i>${esc(b || '—')}</span></div>`,
          )
          .join('')}
      </div>`
          : ''
      }
      ${footer('05', 'Voice & Tone', '08')}
    </section>`)
  }

  // 09 DOS & DON'TS --------------------------------------------------------
  if (dos.length || donts.length) {
    const rows = Math.max(dos.length, donts.length)
    const cells = (list: string[], ok: boolean): string =>
      Array.from({ length: rows })
        .map((_, i) =>
          list[i]
            ? `<li class="rule"><span class="rule-i" style="color:${ok ? secondary : accent}">${ok ? '✓' : '✕'}</span>${esc(list[i])}</li>`
            : '',
        )
        .join('')
    pages.push(`<section class="page rules-page">
      ${eyebrow('06', 'Usage')}
      <h2 class="page-title">Do &amp; don't</h2>
      <div class="rules-split">
        <div class="rules-col do" style="border-top:6px solid ${secondary}"><span class="rules-cap" style="color:${secondary}">Do</span><ul class="rules-list">${cells(dos, true)}</ul></div>
        <div class="rules-col dont" style="border-top:6px solid ${accent}"><span class="rules-cap" style="color:${accent}">Don't</span><ul class="rules-list">${cells(donts, false)}</ul></div>
      </div>
      ${footer('06', 'Usage', '09')}
    </section>`)
  }

  // 10 APPLICATIONS -- CSS mockups on a grid -------------------------------
  {
    const onP = onColor(primary)
    const onA = onColor(accent)
    const onS = onColor(secondary)
    const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'nalu'
    pages.push(`<section class="page apps">
      ${eyebrow('07', 'Applications')}
      <h2 class="page-title">In the <em>world</em></h2>
      <p class="lead">Every surface is built from the same palette, type and wave — nothing borrowed, nothing off-system.</p>
      <div class="apps-grid">
        <div class="mock card-mock" style="background:${primary};color:${onP}">
          <div class="bc-top">${waveMark(onP)}<span style="font-family:${headStack}">${esc(name)}</span></div>
          <div class="bc-bottom"><span class="bc-name">Avery Okafor</span><span class="bc-role" style="color:${softOn(primary)}">Brand Director</span><span class="bc-web" style="color:${softOn(primary)}">n4lu.ai · hello@n4lu.ai</span></div>
          <span class="mock-tag">Business card</span>
        </div>
        <div class="mock social-mock" style="background:linear-gradient(140deg,${secondary},${mix(secondary, primary, 0.5)});color:${onS}">
          <div class="soc-wave">${wave(onS, 0.5)}</div>
          <h3 class="soc-h" style="font-family:${headStack}">${esc(tagline)}</h3>
          <span class="soc-handle">@${esc(handle)}</span>
          <span class="mock-tag">Social tile</span>
        </div>
        <div class="mock ui-mock" style="background:${paper};color:${ink}">
          <div class="ui-bar" style="background:${primary};color:${onP}"><span class="ui-dot">${waveMark(onP)}</span><span style="font-family:${headStack}">${esc(name)}</span><span class="ui-cta" style="background:${accent};color:${onA}">Try ${esc(name)}</span></div>
          <div class="ui-body"><div class="ui-h" style="font-family:${headStack};color:${ink}">Intelligence,<br>calm as the sea.</div><span class="ui-sub" style="color:rgba(11,20,24,.55)">${esc(tagline)}</span><span class="ui-btn" style="background:${primary};color:${onP}">Get started</span></div>
          <span class="mock-tag">Product hero</span>
        </div>
        <div class="mock swatch-mock" style="background:${accent};color:${onA}">
          <span class="sm-big" style="font-family:${headStack}">${esc(name)}</span>
          <span class="sm-sub" style="color:${softOn(accent)}">Signage &amp; merch</span>
          ${waveMark(onA)}
          <span class="mock-tag">Environment</span>
        </div>
      </div>
      ${footer('07', 'Applications', '10')}
    </section>`)
  }

  // 11 CLOSING / COLOPHON -- full-bleed, bookends the cover ----------------
  {
    const on = onColor(primary)
    const grad = `linear-gradient(210deg, ${mix(primary, secondary, 0.45)} 0%, ${primary} 55%, ${mix(primary, '#000000', 0.2)} 100%)`
    pages.push(`<section class="page bleed closing" style="background:${grad};color:${on}">
      <div class="closing-wave">${wave(on, 0.85)}</div>
      <div class="closing-mid">
        <span class="closing-mark">${waveMark(on)}</span>
        <h2 class="closing-h">${esc(name)}</h2>
        <p class="closing-tag" style="color:${softOn(primary)}">${esc(tagline)}</p>
      </div>
      <footer class="closing-foot" style="border-color:${hairOn(primary)};color:${softOn(primary)}">
        <div><span class="cf-k">Web</span> n4lu.ai</div>
        <div><span class="cf-k">Contact</span> hello@n4lu.ai</div>
        <div><span class="cf-k">Edition</span> 01 · ${year}</div>
      </footer>
    </section>`)
  }

  // =======================================================================
  // CSS
  // =======================================================================
  const css = `
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:${bodyStack};color:${ink};background:#5a6066;line-height:1.55;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.book{margin:0 auto}
/* Text pages size to content — no min-height, no overflow clipping (content
   that exceeds A4 flows to the next printed page rather than being cut). */
.page{position:relative;width:210mm;margin:0 auto 10mm;background:${paper};box-shadow:0 18px 50px rgba(0,0,0,.35)}
/* Only bleed pages are tall + clipped (the wave bleeds to the edges). */
.bleed{min-height:297mm;display:flex;flex-direction:column;overflow:hidden}
.contents,.values,.logo,.color,.voice,.rules-page,.apps{padding:30mm 26mm 20mm}
.color{padding:24mm 0 16mm}
h1,h2,h3,blockquote{font-family:${headStack};font-weight:400;letter-spacing:-.015em;line-height:1.04}
.page-title{font-size:58px;font-weight:400;letter-spacing:-.02em;margin:10px 0 26px}
.page-title em{font-style:italic;color:${accent}}
.lead{font-size:17px;max-width:62ch;color:rgba(11,20,24,.72);margin-bottom:20px}

.eyebrow{display:flex;align-items:center;gap:14px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;font-weight:500}
.eye-num{color:${accent};font-family:${headStack};font-size:14px}
.eye-line{flex:0 0 46px;height:2px;background:${ink};opacity:.35}
.eye-label{opacity:.8}
.eyebrow.on .eye-line{flex-basis:46px;opacity:.6}

.foot{margin-top:34px}
.foot-rule{display:block;height:1px;background:rgba(11,20,24,.16);margin-bottom:10px}
.foot-row{display:flex;justify-content:space-between;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(11,20,24,.5)}
.foot-mid{font-family:${headStack}}

.wave{display:block;width:100%;height:auto}
.mark{width:48px;height:30px;flex:0 0 auto}

/* COVER */
.cover{padding:24mm 22mm;justify-content:space-between}
.cover-glow{position:absolute;inset:0;pointer-events:none}
.cover-top,.cover-mid,.cover-wave,.cover-foot{position:relative;z-index:2}
.cover-top{display:flex;justify-content:space-between;align-items:center;font-size:13px;letter-spacing:.18em;text-transform:uppercase}
.cover-mark{display:flex;align-items:center;gap:12px;font-family:${headStack};font-size:20px;letter-spacing:0;text-transform:none;font-weight:600}
.cover-mid{margin-top:auto;margin-bottom:auto}
.cover-kicker{font-size:12px;letter-spacing:.42em;text-transform:uppercase;margin-bottom:22px;font-weight:500}
.cover-name{font-size:138px;font-weight:400;letter-spacing:-.025em;line-height:.94;word-break:break-word}
.cover-tag{font-size:23px;font-family:${headStack};font-style:italic;font-weight:400;margin-top:22px;max-width:32ch;opacity:.92}
.cover-wave{margin:30px 0 24px}
.cover-foot{display:flex;justify-content:space-between;font-size:12px;letter-spacing:.16em;text-transform:uppercase;border-top:1px solid;padding-top:16px;gap:16px}

/* CONTENTS */
.toc{list-style:none;margin:6px 0 0}
.toc-row{display:flex;align-items:baseline;gap:16px;padding:17px 0;border-bottom:1px solid rgba(11,20,24,.1)}
.toc-n{font-family:${headStack};font-size:22px;font-weight:600;color:${accent};flex:0 0 46px}
.toc-t{font-family:${headStack};font-size:24px;font-weight:600;letter-spacing:-.01em}
.toc-dots{flex:1;border-bottom:1.5px dotted rgba(11,20,24,.25);margin-bottom:5px}
.toc-s{font-size:13px;color:rgba(11,20,24,.55);letter-spacing:.02em;text-align:right;flex:0 0 auto}
.contents-note{margin-top:26px;font-size:15px;color:rgba(11,20,24,.6);max-width:60ch}

/* SPLIT (essence / type) — equal-height two-panel, never a gap */
.split{display:grid;grid-template-columns:1fr 1fr;align-items:stretch}
.split-color{position:relative;padding:24mm 18mm;display:flex;flex-direction:column;overflow:hidden}
.split-num{position:absolute;top:14mm;right:16mm;font-family:${headStack};font-size:150px;font-weight:700;line-height:1;pointer-events:none}
.pull{font-family:${headStack};font-size:34px;font-weight:500;line-height:1.12;letter-spacing:-.02em;margin:auto 0;padding-left:20px;border-left:3px solid}
.split-wave{margin-top:auto}.split-wave .wave{height:90px}
.split-body{padding:24mm 22mm 16mm;display:flex;flex-direction:column}
.split-h{font-size:52px;font-weight:400;letter-spacing:-.02em;margin-bottom:28px}
.split-h em{font-style:italic;color:${accent}}
.essence-list{display:flex;flex-direction:column;gap:22px}
.essence-k{font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;margin-bottom:7px}
.essence-v{font-size:18px;line-height:1.5;color:rgba(11,20,24,.82)}
.split-body .foot{margin-top:auto;padding-top:30px}

/* VALUES */
.val-grid{display:grid;gap:1px;background:rgba(11,20,24,.1);border:1px solid rgba(11,20,24,.1)}
.val-card{background:${paper};padding:26px 24px;display:flex;flex-direction:column;min-height:170px}
.val-n{font-family:${headStack};font-size:34px;font-weight:700;margin-bottom:12px}
.val-label{font-size:21px;font-weight:600;letter-spacing:-.01em;margin-bottom:8px}
.val-desc{font-size:14px;line-height:1.5;color:rgba(11,20,24,.62)}

/* LOGO */
.logo-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:8px 0 20px}
.logo-cell{aspect-ratio:16/10;border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;position:relative;padding:24px;overflow:hidden}
.logo-lockup{display:flex;align-items:center;gap:14px;font-size:38px;font-weight:600}
.logo-lockup.small{font-size:30px}.logo-lockup.tiny{font-size:19px;gap:8px}
.logo-lockup .mark{width:54px;height:34px}
.logo-lockup.small .mark{width:42px;height:26px}
.logo-lockup.tiny .mark{width:28px;height:18px}
.logo-cap{position:absolute;bottom:14px;font-size:11px;letter-spacing:.14em;text-transform:uppercase}
.clearspace{position:relative;padding:34px;outline:2px dashed rgba(11,20,24,.28)}
.cs-edge{position:absolute;background:${accent};opacity:.5}
.cs-t,.cs-b{left:34px;right:34px;height:2px}.cs-t{top:16px}.cs-b{bottom:16px}
.cs-l,.cs-r{top:34px;bottom:34px;width:2px}.cs-l{left:16px}.cs-r{right:16px}
.logo-specs{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:22px}
.spec{border-left:3px solid ${secondary};padding-left:14px}
.spec-k{font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;color:${secondary}}
.spec p{font-size:14px;color:rgba(11,20,24,.72);margin-top:5px;line-height:1.45}
.misuse-h{font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:${accent};display:block;margin-bottom:12px}
.misuse-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.mis-cell{display:flex;flex-direction:column;gap:8px}
.mis-art{position:relative;background:#fff;border:1px solid rgba(11,20,24,.12);border-radius:4px;height:80px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.mis-x{position:absolute;top:6px;right:8px;color:${accent};font-size:16px;font-weight:700;z-index:3}
.mis-lbl{font-size:11px;color:rgba(11,20,24,.6);letter-spacing:.04em}

/* COLOR */
.color-intro{padding:0 22mm}
.swatch-stack{margin-top:18px;border-top:1px solid rgba(11,20,24,.08)}
.swatch{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding:26px 22mm;min-height:96px}
.sw-left{display:flex;flex-direction:column;gap:3px;max-width:54%}
.sw-role{font-size:11px;letter-spacing:.2em;text-transform:uppercase;font-weight:700}
.sw-name{font-family:${headStack};font-size:28px;font-weight:600;letter-spacing:-.01em}
.sw-usage{font-size:13px;line-height:1.4;margin-top:4px}
.sw-specs{display:flex;gap:30px;flex:0 0 auto}
.sw-spec{display:flex;flex-direction:column;gap:3px;font-variant-numeric:tabular-nums}
.sw-spec b{font-size:10px;letter-spacing:.16em;font-weight:700;opacity:.7}
.sw-spec span{font-size:14px;font-weight:500;letter-spacing:.02em}

/* TYPOGRAPHY */
.type .split-num{top:12mm}
.aa{font-size:170px;font-weight:700;line-height:.8;letter-spacing:-.04em;margin:14px 0 22px}
.type-pair{display:flex;flex-direction:column;gap:10px;margin-bottom:auto}
.tp-row{display:flex;align-items:baseline;gap:16px;border-bottom:1px solid;padding-bottom:8px}
.tp-k{font-size:11px;letter-spacing:.2em;text-transform:uppercase;flex:0 0 64px;font-weight:700}
.tp-v{font-size:26px}
.alpha{font-size:21px;line-height:1.25;letter-spacing:.01em;margin-top:24px}
.type-note{font-size:15px;line-height:1.55;color:rgba(11,20,24,.72);margin-bottom:24px;max-width:46ch}
.ladder{display:flex;flex-direction:column;gap:18px;border-top:1px solid rgba(11,20,24,.1);padding-top:18px}
.lad-row{display:flex;flex-direction:column;gap:5px}
.lad-meta{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:rgba(11,20,24,.5);font-weight:600}
.lad-spec{color:${ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* VOICE */
.voice-grid{display:grid;gap:14px;margin:6px 0 24px}
.voice-card{background:#fff;border:1px solid rgba(11,20,24,.1);border-radius:5px;padding:22px 20px;position:relative;min-height:130px}
.voice-bar{position:absolute;top:0;left:0;width:42px;height:5px;border-radius:0 0 4px 0}
.voice-label{font-size:20px;font-weight:600;margin:14px 0 8px}
.voice-desc{font-size:14px;line-height:1.5;color:rgba(11,20,24,.62)}
.say-table{border:1px solid rgba(11,20,24,.12);border-radius:6px;overflow:hidden}
.say-head{display:grid;grid-template-columns:1fr 1fr;background:rgba(11,20,24,.04)}
.say-head span{padding:13px 18px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;font-weight:700}
.say-dont{border-left:1px solid rgba(11,20,24,.1)}
.say-row{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid rgba(11,20,24,.1)}
.say-cell{padding:14px 18px;font-size:15px;display:flex;gap:10px;line-height:1.45}
.say-cell.dont{border-left:1px solid rgba(11,20,24,.1);color:rgba(11,20,24,.6)}
.say-cell i{font-style:normal;font-weight:700;flex:0 0 auto}

/* RULES (do/don't) */
.rules-split{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.rules-col{background:#fff;border:1px solid rgba(11,20,24,.1);padding:22px 22px 26px}
.rules-cap{font-size:13px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;display:block;margin-bottom:16px}
.rules-list{list-style:none;display:flex;flex-direction:column;gap:13px}
.rule{display:flex;gap:11px;font-size:15px;line-height:1.45;color:rgba(11,20,24,.82)}
.rule-i{font-weight:700;flex:0 0 auto}

/* APPLICATIONS */
.apps-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:6px}
.mock{position:relative;border-radius:6px;overflow:hidden;min-height:200px;padding:24px;display:flex;flex-direction:column}
.mock-tag{position:absolute;bottom:12px;right:14px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;opacity:.6}
.card-mock{aspect-ratio:1.75/1;justify-content:space-between}
.bc-top{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:600}
.bc-top .mark{width:34px;height:22px}
.bc-bottom{display:flex;flex-direction:column;gap:3px}
.bc-name{font-size:16px;font-weight:600;font-family:${headStack}}
.bc-role,.bc-web{font-size:12px}
.social-mock{aspect-ratio:1.75/1;justify-content:flex-end;position:relative}
.soc-wave{position:absolute;top:0;left:0;right:0;opacity:.6}.soc-wave .wave{height:70px}
.soc-h{font-size:26px;font-weight:600;line-height:1.08;letter-spacing:-.02em;position:relative}
.soc-handle{font-size:13px;margin-top:8px;opacity:.85}
.ui-mock{padding:0;overflow:hidden}
.ui-bar{display:flex;align-items:center;gap:10px;padding:12px 16px;font-size:15px;font-weight:600}
.ui-bar .mark{width:26px;height:16px}
.ui-cta{margin-left:auto;font-size:11px;padding:6px 12px;border-radius:20px;font-weight:600;letter-spacing:.02em}
.ui-body{padding:24px 20px 40px}
.ui-h{font-size:30px;font-weight:600;line-height:1.06;letter-spacing:-.02em}
.ui-sub{display:block;font-size:13px;margin:10px 0 16px}
.ui-btn{display:inline-block;font-size:13px;padding:9px 18px;border-radius:24px;font-weight:600}
.swatch-mock{aspect-ratio:1.75/1;justify-content:center;align-items:flex-start;gap:6px}
.sm-big{font-size:38px;font-weight:700;letter-spacing:-.03em}
.sm-sub{font-size:13px;letter-spacing:.1em;text-transform:uppercase}
.swatch-mock .mark{width:54px;height:34px;margin-top:8px}

/* CLOSING */
.closing{padding:24mm 22mm;justify-content:space-between}
.closing-wave{position:absolute;top:30mm;left:0;right:0;opacity:.5}.closing-wave .wave{height:140px}
.closing-mid{margin:auto 0;position:relative;z-index:2}
.closing-mark .mark{width:80px;height:50px;margin-bottom:24px}
.closing-h{font-size:120px;font-weight:700;letter-spacing:-.045em;line-height:.9;word-break:break-word}
.closing-tag{font-size:22px;font-family:${bodyStack};font-weight:300;margin-top:18px}
.closing-foot{display:grid;grid-template-columns:repeat(3,auto);justify-content:space-between;gap:20px;border-top:1px solid;padding-top:18px;font-size:14px;position:relative;z-index:2}
.cf-k{display:block;font-size:11px;letter-spacing:.18em;text-transform:uppercase;opacity:.7;margin-bottom:4px}

@media print{
  @page{size:A4;margin:0}
  body{background:#fff}
  .book{margin:0}
  .page{margin:0;box-shadow:none;page-break-after:always;break-after:page;width:210mm}
  .bleed{min-height:297mm}
}
`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — Brand Guidelines</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${esc(fontLink)}" rel="stylesheet">
<style>${css}</style>
</head>
<body>
<div class="book">
${pages.join('\n')}
</div>
</body>
</html>`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  if (!LLM_KEY) {
    res.status(500).json({ error: 'Nalu engine is not configured.' })
    return
  }
  let body: Record<string, unknown> = {}
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}
  } catch {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    res.status(400).json({ error: 'prompt required' })
    return
  }
  const kind = normalizeKind(body.kind)
  try {
    const upstream = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        max_tokens: maxTokensFor(kind),
        messages: [
          { role: 'system', content: getSystemPrompt(kind) },
          {
            role: 'user',
            content:
              prompt +
              brandHint(body.brand, kind) +
              designSystemHint(prompt, kind, typeof body.system === 'string' ? body.system : undefined),
          },
        ],
      }),
    })
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '')
      res.status(502).json({ error: `Design upstream ${upstream.status}: ${t.slice(0, 200)}` })
      return
    }
    const d = (await upstream.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = d?.choices?.[0]?.message?.content || ''

    if (HTML_KINDS.has(kind)) {
      // Existing webpage/poster path — preserved byte-compatibly.
      const html = cleanHtml(content)
      if (!html || !/<html|<!doctype|<body|<div/i.test(html)) {
        res.status(502).json({ error: 'Could not build the design. Try rephrasing.' })
        return
      }
      // webpage stays exactly { html, name } for backward compatibility; poster
      // adds kind so the client can route, html shape is identical.
      if (kind === 'webpage') {
        res.status(200).json({ html, name: 'Nalu Design' })
      } else {
        res.status(200).json({ kind, html, name: 'Nalu Design' })
      }
      return
    }

    // brand: the model returns structured CONTENT; we render the fixed book.
    if (kind === 'brand') {
      const parsed = extractJson(content)
      if (!parsed || typeof parsed !== 'object') {
        res.status(502).json({ error: 'Could not build the brand book. Try rephrasing.' })
        return
      }
      const html = buildBrandBookHtml(parsed as Record<string, unknown>)
      res.status(200).json({ kind: 'brand', html, name: 'Nalu Studio' })
      return
    }

    // JSON kinds: canvas | palette | blueprint.
    const payload = buildJsonPayload(kind, content)
    if (!payload) {
      res.status(502).json({ error: 'Could not build the design. Try rephrasing.' })
      return
    }
    res.status(200).json(payload)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'design error' })
  }
}
