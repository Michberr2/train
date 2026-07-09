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

import { cors } from './_cors'
import { chatComplete } from './_llm'
import { research } from './web'
import { identityForRequest, identityBlock } from './_db'
import { reserveStudioQuota, studioLimitMessage } from './_limits'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_KEY = env('TINKER_API_KEY') || ''
const LLM_MODEL = env('NALU_DESIGN_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

// ── Web grounding ────────────────────────────────────────────────────────────
// Before building a brand book / site / logo for a REAL company, research the
// actual brand on the web (colors, fonts, copy) so the output reflects reality
// instead of the model's guess. Best-effort: if the site blocks us or isn't
// found, we return '' and generation proceeds normally.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function topMatches(arr: string[], n: number): string[] {
  const count = new Map<string, number>()
  for (const a of arr) {
    const k = a.trim()
    if (k) count.set(k, (count.get(k) || 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0])
}

function deriveUrl(prompt: string, kind: string): string | null {
  const u = prompt.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"')]*/i)
  if (u) return u[0]
  const dom = prompt.match(/\b([a-z0-9-]{2,}\.(?:com|ai|io|co|net|org|app|dev|studio|design|xyz))\b/i)
  if (dom) return `https://${dom[1].toLowerCase()}`
  // For brand/logo/webpage of a NAMED company ("brand book for Hillpointe"), try <name>.com.
  if (kind === 'brand' || kind === 'logo' || kind === 'webpage') {
    const m = prompt.match(/\b(?:for|of|by)\s+([A-Z][A-Za-z0-9&]+(?:\s+[A-Z][A-Za-z0-9&]+){0,2})/)
    if (m) {
      const name = m[1].replace(/\s+/g, '').toLowerCase()
      if (name.length >= 3) return `https://${name}.com`
    }
  }
  return null
}

async function fetchText(url: string, ms: number): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,text/css,*/*' }, signal: ctrl.signal, redirect: 'follow' })
    return r.ok ? await r.text() : ''
  } catch {
    return ''
  } finally {
    clearTimeout(t)
  }
}

async function researchSite(prompt: string, kind: string): Promise<string> {
  const url = deriveUrl(prompt, kind)
  if (!url) return ''
  // Most brand sites are SPAs that return a near-empty HTML shell to a raw fetch,
  // so get the RENDERED copy through the Jina reader proxy; use the raw HTML + its
  // CSS only to mine the real brand colors/fonts.
  const [reader, rawHtml] = await Promise.all([fetchText('https://r.jina.ai/' + url, 11000), fetchText(url, 6000)])
  if (!reader && !rawHtml) return ''

  let title = ''
  let content = ''
  if (reader && reader.length > 200) {
    title = (reader.match(/^Title:\s*([^\n]+)/m)?.[1] || '').trim()
    content = reader
      .replace(/^Title:[^\n]*\n/m, '')
      .replace(/^URL Source:[^\n]*\n/m, '')
      .replace(/^Markdown Content:\s*/im, '')
      .replace(/We use essential cookies[\s\S]{0,400}?(?:traffic\.|policy\.?|Accept[^\n]*)/i, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // drop image md
      .replace(/\s+/g, ' ')
      .trim()
  } else if (rawHtml) {
    title = (rawHtml.match(/<title[^>]*>([^<]{1,140})/i)?.[1] || '').trim()
    content = rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  content = content.slice(0, 1800)

  // Brand colors + fonts: from the raw HTML + its linked CSS.
  let css = rawHtml
  const cssUrls = [...rawHtml.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1], url).href
      } catch {
        return ''
      }
    })
    .filter(Boolean)
    .slice(0, 3)
  for (const c of cssUrls) css += '\n' + (await fetchText(c, 5000))
  const colors = topMatches(css.match(/#[0-9a-fA-F]{6}\b/g) || [], 12)
    .filter((c) => !/^#f{6}$|^#0{6}$/i.test(c))
    .slice(0, 8)
  const fonts = topMatches(
    (css.match(/font-family:\s*([^;}"']+)/gi) || []).map((s: string) => s.replace(/font-family:\s*/i, '').trim().slice(0, 60)),
    5,
  )

  const parts = [
    `REAL BRAND DATA researched live from ${url} — base the output on THIS faithfully (the ACTUAL brand's name, industry, positioning, colors, fonts and voice). Do NOT invent a different industry, name, or made-up colors:`,
    title && `- Name: ${title}`,
    colors.length ? `- Actual brand colors (hex): ${colors.join(', ')}` : '',
    fonts.length ? `- Actual fonts: ${fonts.join(' | ')}` : '',
    content && content.length > 60 ? `- Real website content (their positioning, services, tone — anchor the brand book to this): ${content}` : '',
  ].filter(Boolean)
  return parts.length > 1 ? parts.join('\n') : ''
}

type DesignKind = 'webpage' | 'poster' | 'canvas' | 'palette' | 'brand' | 'blueprint' | 'logo' | 'shopping' | 'motion' | 'game' | 'board' | 'carousel'

// HTML-bearing kinds go through cleanHtml + the design-system layer.
const HTML_KINDS: ReadonlySet<DesignKind> = new Set<DesignKind>(['webpage', 'poster', 'motion', 'game', 'board'])

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
    k === 'motion' ||
    k === 'game' ||
    k === 'board' ||
    k === 'carousel'
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
- Palette (the real Four Seasons × Hillpointe house colors): deep navy-black (#0F1B2D and #14345A), warm off-white neutrals (#F5F6F8, ivory, stone), crisp near-black text (#1F1F1F), and ONE restrained antique-gold accent (#AF8C56, lighter sheen #E4B96F) used sparingly for hairlines, eyebrows and key moments. Mostly black/navy on white. Avoid bright, neon or saturated colors.
- Typography: PREFER an elegant high-contrast display serif — **Playfair Display** (or Cormorant Garamond / Fraunces) — for headlines at a refined LIGHT weight, paired with **Work Sans** (or Jost / Inter) for body. Load both from Google Fonts. Use UPPERCASE, widely letter-spaced (0.2–0.3em) small labels. Mix in occasional italic-serif emphasis.
- Thin hairline rules, refined detailing, real specific copy — never lorem ipsum, never a stale year (use 2026 if needed).`

// The world-class execution spec — distilled from research on Awwwards Site
// of the Year winners (Lando Norris/OFF+BRAND, Messenger, Igloo Inc), the top
// WebGL studios (Lusion, Active Theory, Unseen), the craft systems of
// Apple/Linear/Stripe/Vercel, and the documented "AI slop" tells to ban.
const WORLD_CLASS_SPEC = `WORLD-CLASS EXECUTION SPEC — every site must compete with Awwwards winners (judges weight Design 40% / Usability 30% / Creativity 20% / Content 10%; polish and hierarchy beat effect count):

STRUCTURE & LAYOUT
- Hero is 100svh, dominated by display type spanning 85-95% of viewport width. NEVER center-stack every section — compose on a 12-column grid with 4-6vw outer margins: asymmetric spans (heading cols 1-8, supporting copy cols 9-12; 7/5 or 8/4 media/text splits), and let at least one element bleed across a section boundary.
- Alternate density: a full-bleed image/WebGL section, then a sparse editorial section with 20-30vh padding. Section padding 120-240px desktop and VARIED — identical padding on every section is the #1 template tell. Polarity-flip at least one band (light canvas → near-black band → light) as a pacing cue.
- Include at least ONE of these award-site signatures: a pinned section (position:sticky headline/media while content scrolls past, driving a counter/text-swap/transform), a horizontal-scroll gallery (tall container, track translateX driven by scroll), or an infinite text marquee (6-10vw uppercase, content duplicated 2x, 20-40s linear loop).
- Number sections in small mono uppercase meta ("01 — Work"). End with an OVERSIZED footer: a 10-16vw wordmark or CTA, roll-up contact links, small mono meta (year, city, time). No preloader — first paint must be instant.

TYPOGRAPHY (max 2 Google Font families)
- One distinctive DISPLAY voice + one quiet body face. Premium Google-Fonts picks — display: Bricolage Grotesque, Archivo (Expanded, 800-900), Unbounded, Newsreader, Cormorant Garamond, Libre Caslon Display, Anton; body: Work Sans, Source Sans 3, IBM Plex Sans, Inter (body ONLY, never as display). NEVER Inter/Roboto/Poppins/system-ui as the display face.
- Hero display: font-size clamp(3.5rem, 10vw, 11rem), line-height 0.85-0.95, letter-spacing -0.02em to -0.04em, weight 400-650 (never blanket 700+ everywhere). Jump straight from giant display to 16-18px body — skip middling sizes. Labels/eyebrows: 11-12px uppercase mono, letter-spacing 0.08-0.14em. tabular-nums on all stats. text-wrap:balance on headings.
- Body ink is tinted, never pure black-on-white (#171717 on #F7F5F1, or #E8E6E1 on #0E0E0E). Body max-width 60-72ch, line-height 1.5-1.6.

COLOR & TEXTURE
- Exactly 3 colors: a near-black (#0A0A0A-#141414) or warm off-white (#F4F1EA) ground, its opposite for type, plus ONE saturated accent (acid lime, electric blue, signal orange, oxblood — pick what fits the SUBJECT) at <10% of surface — CTAs, links, one highlighted word. BANNED: indigo/violet SaaS defaults (#6366F1/#8B5CF6), blue-to-purple gradients, gradient text, glowing purple orbs, colored left-border cards.
- Texture beats flatness: a full-page SVG feTurbulence grain overlay at 3-5% opacity (pointer-events:none), hairline 1px dividers at 10-15% foreground opacity. No shadow-lg-on-everything: dark themes use layered surfaces + hairlines (no shadows); light themes use stacked subtle shadows with an inset hairline.
- NO row of 3+ identical icon-cards. Use a bento grid with mixed spans, an editorial numbered list with hairline dividers, or alternating 7/5 media+text rows instead.

MOTION CHOREOGRAPHY (one easing family site-wide: cubic-bezier(0.16,1,0.3,1))
- Hero reveal: split the headline by LINE, each line in an overflow:hidden mask, translateY(110%)→0, 0.9-1.2s, 0.08-0.12s stagger — never fade the whole block.
- Scroll reveals (IntersectionObserver, once, ~15% visibility): opacity 0→1 + translateY 48px→0 with 0.06-0.1s sibling stagger. Images reveal via clip-path inset(100% 0 0 0)→inset(0) or scale 1.12→1 inside an overflow-hidden frame, with 10-20% parallax inside the mask.
- Micro-interactions 150-300ms ease-out on EVERY interactive element: link hovers use the roll-up duplicate pattern (two stacked copies in an overflow:hidden span, hover translateY -100%); buttons get a real hover shift. Animate ONLY transform/opacity. Respect prefers-reduced-motion.
- Stats count up from 0 on first view (1-1.5s, tabular-nums).

COPY & CONTENT
- Headlines: short, concrete, specific — a real noun/number a competitor couldn't claim ("Bread proofed 48 hours." not "Elevate your mornings"). BAN: streamline, empower, seamless, unlock, elevate, world-class, "Build the future".
- Every section carries genuinely written, subject-specific content — real menu items with prices, real names, real hours/addresses. Specificity IS the design.

SELF-CHECK before finishing — fix any hit: (1) every section centered, (2) any row of 3+ identical cards, (3) uniform rounded-2xl + shadow everywhere, (4) generic font at default tracking for headings, (5) purple-blue gradient anywhere, (6) identical section padding throughout, (7) a hero under 80vh, (8) mobile menu visible on desktop.`

const SYSTEM_HTML = `You are an award-winning front-end designer & engineer (Awwwards / FWA caliber). Output ONE complete, self-contained, downloadable .html file that FULLY implements the request.

BUILD EXACTLY WHAT THE USER ASKED FOR — first identify the type, then build THAT:
- Marketing / landing page → the rich multi-section layout in the "FOR A MARKETING / LANDING PAGE" block below.
- Web app, SaaS tool, dashboard, admin panel, calculator, form, editor, quiz, game, or interactive component → a FUNCTIONAL UI with REAL WORKING interactivity (vanilla-JS state and event handlers) in the layout that type actually needs (app shell, sidebar, toolbar, canvas, data tables, inputs, controls) — NOT a hero-and-testimonials marketing page.
- STORAGE — HARD RULE: the preview runs in a sandboxed iframe where localStorage/sessionStorage THROW SecurityError and one unguarded call at script top level kills ALL your JavaScript. NEVER access localStorage/sessionStorage/document.cookie directly — keep all state in plain JS variables/objects. If persistence would genuinely help, wrap every storage touch in its own try/catch — but in-memory state is always the right default.
- Multi-page site → build EVERY page in this ONE file with client-side navigation (JS show/hide or hash routing) and a shared nav; every page fully built, not just a home page.
Match the request's real purpose, content, and structure. Use the landing-page structure ONLY when the user actually wants a landing/marketing page; otherwise ignore it and build the thing they asked for, to the same quality bar.

DEFAULT FOR A "WEBSITE" / "SITE" REQUEST (when they don't specifically say "landing page"): build a MULTI-PAGE site — a Home page PLUS 3–5 real, fully-written pages chosen to fit the subject (e.g. About, Services/Features, Work/Portfolio/Gallery, Pricing, Blog, Contact) — with a shared nav and WORKING client-side routing (hash routing or JS show/hide) so clicking a nav link actually switches the visible page and the back/forward buttons work. Every page must be complete and substantive (real copy, sections, images) — never a stub, placeholder, or "coming soon". Highlight the active nav link. This is a real, multi-page, fully-functional website.

FULLY BAKED — NO SKELETONS, EVER (hard rule, regardless of how short the user's ask was): a one-line request gets the SAME finished, rich site as a detailed spec. Home = hero + 5-8 substantive sections. EVERY secondary page = its own intro header + at least 3 real sections of genuinely written content (real menu items with prices, real service descriptions, real team bios, real FAQ answers, plausible addresses/hours/testimonials with names) — never one heading with a sentence under it. If you would ship a section with under ~40 words of real copy, write more instead. A page that feels like a wireframe or template is a FAILED build.

${WORLD_CLASS_SPEC}

ART DIRECTION — commit HARD to one direction that fits THIS subject: name it to yourself first (brutalist editorial? sun-bleached analog? Swiss technical? quiet luxury? acid streetwear?), then execute it in every token — a bakery, a law firm, a skate brand and a SaaS should produce sites that look NOTHING alike. You statistically converge on centered heroes, safe fonts and template blue — make a different, subject-specific choice every time.

COLORS — TOP PRIORITY: if the user names ANY colors, palette, theme, brand, or vibe (or a brand kit / palette is provided below), use THAT EXACTLY as the entire color scheme (still applying the spec's restraint rules). Never override the user's requested colors.

Output ONLY the raw HTML — start with <!doctype html> and end with </html>. No markdown fences, no explanation.

FOR A MARKETING / LANDING PAGE — build a complete, polished, rich site, every section fully designed:
- A real multi-section page: sticky nav, the 100svh display-type hero over the WebGL scene, then 6–9 substantive sections (features/experiences, how-it-works, a gallery/showcase, a stats row, testimonials, pricing or offerings, FAQ, a closing CTA, and the oversized footer). Real, specific, evocative copy — never lorem ipsum, never sparse.
- HERO: display type + the living WebGL photo scene per the WEBGL section, a small uppercase mono eyebrow, a one-line tagline, ONE clear CTA. The first impression must be stunning and TRUE TO THE SUBJECT (a fintech hero, a streetwear hero, and a luxury-resort hero should look nothing alike).
- DENSITY: each section needs a clear eyebrow + headline + supporting copy and real content (bento grids, an image row, numbers, quotes) with the VARIED section padding from the spec. Never a thin one-liner section. The finished page should feel substantial and editorial, never empty.

NAVIGATION — get this exactly right (these are common failures):
- ONE responsive nav bar. On DESKTOP: a single horizontal row — brand left, links right (smooth-scroll anchors). On MOBILE: links collapse into a hamburger that toggles a menu.
- The hamburger MUST be hidden on desktop, and the desktop links MUST be hidden on mobile — use a media query so EXACTLY ONE is visible at any width. NEVER show both, and never leave a vertical stack of links floating on desktop.
- THE MOBILE MENU IS CLOSED ON LOAD — use this exact known-good skeleton (restyle freely):
  <div id="mnav" hidden> …links… </div> with <button id="burger" onclick="mnav.hidden=!mnav.hidden"> — the hidden ATTRIBUTE (not a class the JS must add) guarantees it starts closed even if scripts fail, and #mnav is display:none on desktop via media query. A mobile menu open on desktop load is an automatic failure.
- LEGIBILITY IS MANDATORY: the nav must have a SEMI-OPAQUE on-brand background — the design's OWN dark/primary color at ~80% opacity (e.g. rgba(r,g,b,0.82)) WITH backdrop-blur — it must NOT be fully transparent and must NOT default to navy unless that's the brand. Nav text/links must be a LIGHT color (near-white / soft gold) with strong contrast against that navy glass, readable over ANY hero image, with a clear hover state. Test: the links must be obviously readable on top of a bright photo.
- The brand/logo in the nav must be a TEXT wordmark or INLINE SVG — NEVER an <img> tag for the logo (it can fail and show a broken-image icon). Likewise never use an <img> for icons; use inline SVG.

FULLY RESPONSIVE — DESKTOP AND MOBILE ARE BOTH PRIMARY SUCCESS CRITERIA. The site must be flawless and beautiful on a 1440px desktop AND a 375px phone — this is non-negotiable, not an afterthought:
- Include <meta name="viewport" content="width=device-width, initial-scale=1">. Build mobile-first, then layer up with min-width media queries (or Tailwind's sm:/md:/lg: breakpoints). EVERY section must have explicit mobile styles.
- NO horizontal scroll ever (no fixed-width elements wider than the viewport). Multi-column grids/flex rows collapse to ONE column on phones. Use fluid type clamp() for ALL large headings so the hero text never overflows. Tap targets ≥44px. Images max-width:100%, height:auto.
- The hamburger menu MUST appear and work on mobile (and be hidden on desktop); desktop links hidden on mobile — exactly one visible at any width. Section padding shrinks on small screens (e.g. py-24 desktop → py-12 mobile). The 4K hero stays object-fit:cover and its text recenters/shrinks to fit a phone.
- Self-check before finishing: mentally render at 375px — is anything cut off, overflowing, overlapping, or too small to tap? Fix it. The phone experience must be as polished as the desktop one.

IMAGES — every image MUST load AND match the subject (themed, not random). Mismatched stock photos are the #1 reason a page looks cheap; themed photography is what makes it look premium like a real brand:
- THE HERO USES THE WEBGL SCENE, NOT A PHOTO (see the WEBGL section — never cover the canvas with an image). Only when the page genuinely skips WebGL (plain document-like page / user said no 3D) does the hero get a photo instead — then it MUST be 4K and razor-sharp: https://image.pollinations.ai/prompt/<URL-ENCODED-SPECIFIC-DESC>?width=3840&height=2160&nologo=true&model=flux&seed=<n> with width:100%, height:100%, object-fit:cover.
- GALLERY / feature images (the other mood-setters): Pollinations at high res — https://image.pollinations.ai/prompt/<URL-ENCODED-SPECIFIC-DESC>?width=1920&height=1280&nologo=true&model=turbo&seed=<n> (model=turbo for speed). For ALL themed images write a SPECIFIC, evocative scene (e.g. "luxury oceanfront infinity pool at golden hour, modern villa, serene cinematic" or "sunlit minimalist bedroom with linen, coastal light"). Up to ~4 themed images.
- Picsum is FORBIDDEN for anything content-bearing (gallery tiles, feature cards, team, menu items) — random stock photos of skyscrapers on a bakery site scream template. Picsum is ONLY for tiny incidental decoration (avatars) and onerror fallbacks; every visible content image must be a THEMED Pollinations scene.
- EVERY <img> MUST be bullet-proof so a failure NEVER shows a broken icon: width + height (or aspect-ratio), object-fit:cover, loading="lazy", a brand-tone CSS background placeholder, AND an onerror that falls back to Picsum:  onerror="this.onerror=null;this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*9999)+'/'+this.width+'/'+this.height'"
- Total images ≤ 7. Keep first paint fast.

ANIMATION & POLISH (tasteful, performant — never gaudy):
- Scroll-reveal: use an IntersectionObserver in vanilla JS to add an "in" class that fades/translates sections in as they enter the viewport (define the transitions in CSS). Stagger children.
- Smooth micro-interactions: hover lifts on cards/buttons, animated underlines, a subtle gradient or parallax in the hero, a sticky nav that condenses on scroll, smooth-scroll for anchor links.
- Respect prefers-reduced-motion. Keep 60fps (transform/opacity only).

WEBGL — REQUIRED AND IT MUST BE SEEN. Every Nalu landing/marketing/multi-page site ships with a real-time WebGL scene as its visual signature (skip ONLY for plain document-like pages or when the user says no 3D). The gold standard is SCROLL-DRIVEN WEBGL STORYTELLING (Lusion / Awwwards-SOTD style, e.g. everswap.com): the whole site feels like ONE continuous 3D world that the visitor travels through as they scroll. Build it like this:
- ONE fixed full-viewport canvas behind the ENTIRE page: <canvas id="gl" style="position:fixed;inset:0;z-index:0;pointer-events:none"> as the FIRST element of <body>, and put the importmap + WebGL module script IMMEDIATELY after it (before all page content) — first-in-body means the scene always boots even if later markup has problems. ALL page content lays above it (a positioned wrapper with z-index:1). Sections use transparent or semi-translucent backgrounds so the scene stays visible while scrolling — NEVER bury the canvas under opaque section backgrounds or photos (the #1 failure).
- SCROLL = CAMERA: map native scroll to the journey — const progress = scrollY / (document.documentElement.scrollHeight - innerHeight) — and LERP the camera along a path through the scene (position/rotation keyed to progress), so each page section is a "chapter" of the world: geometry drifts in/out, colors shift, the formation reorganizes as you scroll. Keep native scrolling (no hijack); ease everything (cam.position.lerp / value += (target-value)*0.05) so motion feels liquid.
- STYLIZED / DUOTONE (NPR) LOOK: pick TWO brand colors (a light + a deep tone) and build the whole scene from them — flat-shaded MeshToonMaterial / MeshBasicMaterial geometry, vertex-colored particle fields, wireframes, THREE.Fog(deepColor) for depth fade. Illustrated and graphic like a shader-crafted world, NOT photoreal lighting.
- THE SCENE IS BUILT FROM REAL IMAGERY — this is the hard rule that makes it read as a crafted site instead of a tech demo. Load a THEMED Pollinations photograph as a WebGL TEXTURE and make IT the scene: a full-bleed cinematic photo hero that visibly FLOWS — liquid/wave distortion rippling through the image, a ripple that follows the mouse, slow drift, subtle RGB split. The result looks like an actual living photograph, NOT abstract dots/wireframes. (Particles are allowed only as a LIGHT garnish over the imagery, never as the whole scene.)
- FAIL-OPEN TO THE PHOTO — mandatory belt-and-suspenders: the hero element ALSO carries the SAME image as a CSS background (background:url(<same-pollinations-url>) center/cover, plus a dark scrim for text) BEHIND the transparent canvas, and the render loop STARTS ONLY inside the texture's onLoad callback. Until the texture is ready (or if WebGL fails entirely) the visitor sees the actual cinematic photo — NEVER a black or empty hero. When the texture loads, the living shader version takes over seamlessly.
Implementation — use exactly this proven pattern (fullscreen photo quad + distortion fragment shader):
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
<script type="module">
try {
  const THREE = await import('three');
  const canvas = document.getElementById('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const IMG = 'https://image.pollinations.ai/prompt/<URL-ENCODED-CINEMATIC-SCENE>?width=1920&height=1080&nologo=true&model=turbo&seed=7'; // SAME url as the hero CSS background
  const u = { uTex: { value: null }, uTime: { value: 0 }, uMouse: { value: new THREE.Vector2(0.5, 0.5) }, uScroll: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uImg: { value: new THREE.Vector2(1920, 1080) } };
  const mat = new THREE.ShaderMaterial({ uniforms: u, transparent: true,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D uTex; uniform float uTime; uniform vec2 uMouse; uniform float uScroll; uniform vec2 uRes; uniform vec2 uImg; varying vec2 vUv;\\nvoid main(){ vec2 s = uRes / uImg; float k = max(s.x, s.y); vec2 fit = uImg * k / uRes; vec2 uv = (vUv - 0.5) / fit + 0.5;\\n uv += 0.006 * vec2(sin(uv.y*9.0 + uTime*0.7), cos(uv.x*9.0 + uTime*0.6));\\n float d = distance(vUv, uMouse); uv += 0.02 * exp(-d*9.0) * vec2(sin(d*40.0 - uTime*3.0));\\n uv.y += uScroll * 0.06;\\n vec3 c; c.r = texture2D(uTex, uv + vec2(0.0015,0.0)).r; c.g = texture2D(uTex, uv).g; c.b = texture2D(uTex, uv - vec2(0.0015,0.0)).b;\\n gl_FragColor = vec4(c, 1.0); }' });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  addEventListener('pointermove', (e) => u.uMouse.value.set(e.clientX/innerWidth, 1 - e.clientY/innerHeight), { passive: true });
  const fit = () => { renderer.setSize(innerWidth, innerHeight); u.uRes.value.set(innerWidth, innerHeight); }; addEventListener('resize', fit); fit();
  const tick = (now) => { requestAnimationFrame(tick); u.uTime.value = now/1000; const m = Math.max(1, document.documentElement.scrollHeight - innerHeight); u.uScroll.value += (scrollY/m - u.uScroll.value) * 0.06; renderer.render(scene, cam); };
  const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
  loader.load(IMG, (t) => { t.colorSpace = THREE.SRGBColorSpace; u.uImg.value.set(t.image.width, t.image.height); u.uTex.value = t; requestAnimationFrame(tick); }); // loop starts ONLY when the photo is on the GPU
} catch (e) { /* the CSS photo hero stays — the page still looks great */ }
</script>
Adapt the shader/scene freely (stronger flow for water/motion subjects, gentler for luxury) — but the IMAGE-AS-WEBGL character and the CSS-photo fail-open are both required. If the canvas is hero-only rather than fixed full-site, size it to the hero container instead of the window.
Rules: the whole init lives in ONE try/catch'd module script; requestAnimationFrame loop; never block first paint; text legibility everywhere via translucent panels/scrims over the scene.

TECH: everything inline (CSS in <style>, JS in <script>). You MAY use CDNs: Tailwind (https://cdn.tailwindcss.com), Google Fonts, and optionally a lightweight animation lib via CDN (AOS or GSAP) — but vanilla IntersectionObserver is preferred and dependency-free. Inline SVG for icons/logos. The file must work standalone when downloaded and opened. For apps, tools, dashboards, calculators, forms, and games, the JavaScript must ACTUALLY WORK — implement the real, functional logic and state (not a static mockup): buttons do things, inputs compute, state lives in JS variables (see the STORAGE rule).

FINISH THE ENTIRE BUILD — you have a LARGE output budget, so build the FULL thing AND complete it: output all the way through the final </html>, with every part fully written, fully styled, every tag closed, and all interactivity wired up and working. Do NOT thin out, simplify, shorten, or skip parts to save room, and do NOT stop early — deliver the whole ambitious, finished result. An incomplete or sparse output is a failure. PACE YOURSELF: target roughly 700–1000 lines total — rich and substantial but FINISHED; reaching </html> with every section complete beats an endless page that gets cut off.
Make it genuinely impressive, complete, editorial, and shippable — the calibre of an Awwwards site of the day.`

// Follow-up edits to an existing webpage: instead of regenerating from scratch
// (losing everything the user liked), the model revises the CURRENT html.
const SYSTEM_HTML_EDIT = `You are an award-winning front-end designer & engineer revising an EXISTING self-contained HTML page. The user gives you the current page and a change request. Apply the change request faithfully while PRESERVING everything else — the structure, copy, styling, images, and interactivity that are not part of the request stay exactly as they are.

Rules:
- Output the COMPLETE revised .html file from <!doctype html> to </html> — never a fragment, never a diff, no markdown fences, no explanation.
- Keep the page self-contained (inline CSS/JS; existing CDN links stay).
- NEVER access localStorage/sessionStorage directly (sandboxed preview throws) — in-memory JS state only, or per-call try/catch.
- Keep it fully responsive (desktop + 375px phone), images bullet-proofed with onerror fallbacks, and every tag closed.`

// Executive breakdown board: a photo (or subject) decomposed into a premium,
// print-worthy presentation board — the "Architect's Prompt Vault" style:
// hero image, element-by-element breakdown, materials palette, specs, diagrams.
const SYSTEM_CAROUSEL = `You are the best-in-the-world social media creative director. Design a scroll-stopping, top-1% social post. Output ONLY structured JSON (no HTML, no markdown, no prose) — a fixed, professionally-designed template renders it perfectly, so your job is the STRATEGY, COPY, DESIGN TOKENS and IMAGE DIRECTION.

This is built on 2026 engagement research — carousels are the highest-engagement format; maximize DWELL, SWIPE-COMPLETION and SAVES/SHARES.

Output EXACTLY this shape (minified):
{"platform":"instagram|tiktok|linkedin|pinterest|threads|x|facebook","ratio":"4:5|9:16|1:1","handle":"@handle",
 "theme":{"bg":"#hex","bg2":"#hex (for a gradient; = bg for solid)","ink":"#hex (text on bg — MUST be high-contrast vs bg)","accent":"#hex","headingFont":"Anton|Archivo Black|Bebas Neue|Montserrat|Fraunces","bodyFont":"Inter|DM Sans"},
 "slides":[
   {"kind":"cover","badge":"","headline":"the HOOK ≤10 words","sub":"one supporting line ≤14 words","img":"vivid specific photo scene, or empty string for a clean type slide"},
   {"kind":"point","badge":"01","headline":"one idea ≤8 words","body":["support line ≤14 words","optional 2nd line ≤14 words"],"img":""},
   {"kind":"cta","badge":"","headline":"the CTA ≤8 words (Save/Send/Follow/Comment)","sub":"one line","img":""}
 ],
 "caption":"context the slides don't give — where it came from / why it matters; main keyword first; ~60-90 words IG (punchier TikTok, insight-first LinkedIn) + a CTA line",
 "hashtags":["#Broad","#Niche"]}

RULES:
- PLATFORM: default instagram + ratio 4:5. tiktok/threads/stories → ratio 9:16. Obey a named platform.
- 8-10 slides for IG/LinkedIn (6-8 for vertical): [cover] + one-idea "point" slides + [cta]. Number the point slides (01, 02…).
- HOOK: specific + outcome-led, one of question/shock-stat/promise/list/mistake/curiosity. NEVER generic.
- COPY: real, specific, valuable — teach something. Keep every line SHORT (the limits above are HARD — the renderer sizes text to fit, but short = premium). No lorem ipsum, no filler.
- THEME: a striking modern palette (brand colors if provided) with high-contrast ink and a real accent. Pick ONE display font + ONE body font.
- IMG (OPTIONAL & RARE): give a vivid, specific photo scene ONLY where it elevates (a great cover, maybe 1 more) — AT MOST 2-3 images across the whole post, often ZERO. Leave "img":"" for clean type-driven slides (these look premium). For a visual topic (travel/food/product/interior) use 2-3; for ideas/advice/data prefer type.
- CTA: Save ("Save this for…") / Send ("Send to someone who…") / Follow / Comment. One clear action.
- CAPTION + 5-10 mixed broad+niche HASHTAGS always.
Output ONLY the JSON object.`

const SYSTEM_BOARD = `You are a principal architect + industrial designer + art director producing a PREMIUM EXECUTIVE PRESENTATION BOARD — the kind of dense, sophisticated board a top studio pins up for a client (contemporary minimalist aesthetic, technical language, editorial typography). The user attached a photo which has ALREADY been analyzed for you (the VISUAL ANALYSIS below is ground truth — trust it completely; never say you cannot see the image). Output ONE complete, self-contained .html file that renders the board.

THE BOARD (a single tall scrolling board, like an A1 presentation sheet):
- Masthead: project title (derive an elegant name), subtitle, a small uppercase letter-spaced eyebrow ("EXECUTIVE DESIGN BOARD" or fitting), date (2026), and a hairline-ruled title block like a drawing sheet (project / sheet / scale / drawn-by fields).
- HERO: the user's photo, large and beautifully framed with a caption. Reference it as EXACTLY <img src="{{PHOTO_0}}"> (additional photos, if the analysis mentions them, are {{PHOTO_1}}, {{PHOTO_2}}…). NEVER use any other src for the user's photo — the app substitutes the real image into {{PHOTO_n}}.
- OVERVIEW: a confident 2-3 sentence executive summary of what the subject is, its style/character, and what makes it notable.
- ELEMENT BREAKDOWN — the core: decompose EVERYTHING visible into a clean grid of element cards (10-20 cards). Each card: an uppercase label, the element's description, materials/finish, estimated dimensions where inferable, and a technical note (construction, detailing, or spec language). For architecture: massing, facade composition, roofline, glazing/window systems, cladding materials, entry sequence, landscape, lighting. For products/interiors/other subjects: every significant object, its material, finish, style era, and spec.
- MATERIALS & PALETTE: swatch chips for every material AND color identified — each chip shows a CSS-colored square (estimate the hex from the analysis), the material/color name, and where it appears. 6-12 chips in a row-wrapped grid.
- TECHNICAL SECTION (adapt to the subject): for architecture, include an inline SVG schematic FLOOR PLAN (plausible, derived from the massing — rooms labeled, overall dimensions), plus brief SECTION and ELEVATION notes with dimension callouts; for other subjects, an inline SVG annotated diagram of the subject with leader lines to labeled parts. Draw these diagrams yourself in clean thin-line SVG (blueprint style: 1px strokes, uppercase labels, dimension arrows) — never external images.
- SPECIFICATIONS TABLE: a refined table of key specs (dimensions, materials, finishes, systems, estimated values) drawn from the analysis.
- DESIGN LANGUAGE: typography-led section naming the style movement, era, comparable designers/precedents, and 3-5 defining principles.
- CLOSING: recommendations or enhancement opportunities (3-5 numbered, specific).

AESTHETIC — quiet, expensive, editorial (this board must itself be a design piece):
- Warm paper background (#F7F5F1 or similar), near-black ink text, ONE restrained accent (antique gold #AF8C56 or a color pulled from the photo), hairline rules everywhere, generous whitespace.
- Typography: an elegant high-contrast display serif (Playfair Display / Cormorant Garamond via Google Fonts) for headings, a precise sans (Inter / Work Sans) for labels and body; small uppercase letter-spaced section eyebrows; drawing-sheet numbering on sections (01, 02, 03…).
- Fully responsive: multi-column grids collapse cleanly on a 375px phone; the board must also look right printed.

TECH: everything inline (CSS in <style>), Google Fonts CDN allowed, inline SVG for all diagrams, NO external images except the {{PHOTO_n}} placeholders and NO localStorage. Output ONLY raw HTML from <!doctype html> to </html> — no markdown fences, no explanation. Complete the ENTIRE board — every section fully written with real, specific content from the analysis; never generic filler.`

// Poster: a SINGLE striking graphic on one fixed-aspect artboard — never a
// website. Bold and adaptive to the subject (not forced into the quiet-luxury
// house look), but always following the user's requested colors.
const SYSTEM_POSTER = `You are a world-class poster & graphic designer (Pentagram, the Swiss poster tradition, modern editorial). Output ONE complete, self-contained .html file that renders a SINGLE striking POSTER.

THIS IS A POSTER, NOT A WEBSITE. Absolutely NO nav bar, NO multi-section scrolling page, NO hero+features+footer layout. It is ONE poster on ONE artboard, fully visible at once.

THE ARTBOARD:
- One fixed-aspect poster, centered, that scales to fit fully on screen (no scrolling) and prints/exports cleanly. Use a .poster element with an explicit aspect-ratio and a max height/width (e.g. height: min(94vh, ...)), background filling it edge to edge.
- Choose the aspect ratio from the request: print poster / event flyer → portrait 2:3 (or A-series); Instagram post → 1:1; story/reel → 9:16; otherwise default portrait 4:5. Position everything ON the artboard.

DESIGN IT LIKE A REAL POSTER:
- ONE bold focal idea with a clear hierarchy: a small kicker/eyebrow → a DOMINANT headline (huge, confident type) → a subhead → the essential details (date, place, time, price, CTA / handle). Real, specific copy — never lorem ipsum.
- Make typography the star: pair an expressive display face with a clean grotesk (Google Fonts); use dramatic scale, weight, and letter-spacing; headlines can be very large via clamp(). Big type as image.
- Strong composition: a confident grid or deliberate asymmetry, bold color blocking, generous negative space or full-bleed imagery — gallery quality. Add tasteful detail (rules, a mark, a texture) but stay disciplined.
- CRAFT DENSITY — a top-tier poster is LAYERED, not three lines of text on a color: add a designed backdrop (an inline-SVG graphic motif, geometric composition, texture, or gradient field tied to the subject), supporting information blocks (lineup/program/speakers/acts where the subject implies them, venue + address, ticket info, sponsor/credits line, a small SVG mark or badge, vertical side text or a ticket-stub edge where fitting), and micro-typography details (numbered dates, rules, letter-spaced captions). Every element positioned deliberately on the artboard.
- Adapt the STYLE to the subject and the user's brief (a rave flyer, a museum poster, a tech launch, a wedding invite, a sports event all look different) — do not make every poster look the same.

COLORS — TOP PRIORITY: if the user names ANY colors, palette, brand, or vibe (or a brand kit/palette is provided below), use THAT exactly. Otherwise pick ONE bold, cohesive palette that fits the subject — posters may be saturated and high-impact.

IMAGES (optional, only if it strengthens the poster): a full-bleed photo via Pollinations at high res for a SPECIFIC themed scene — https://image.pollinations.ai/prompt/<URL-ENCODED-DESC>?width=1280&height=1600&nologo=true&model=flux&seed=<n> — set object-fit:cover, a solid CSS background color behind it, and an onerror Picsum fallback so a failed image NEVER shows a broken icon. Use inline SVG for any marks/icons — never <img> for a logo.

TECH: everything inline (CSS in <style>); Tailwind / Google Fonts via CDN are fine. Output ONLY raw HTML from <!doctype html> to </html> — no markdown fences, no explanation. Finish the whole poster, every element placed and styled, every tag closed.`

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
  if (kind === 'game') return '' // games are PlayCanvas, not styled web pages
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

const SYSTEM_GAME = `You are a world-class game developer. Output ONE complete, self-contained .html file that is a GENUINELY FUN, POLISHED, fully PLAYABLE game implementing the user's request, on the PlayCanvas engine. It must actually run and be enjoyable on the FIRST try. No tech demos, no placeholders, no half-built mechanics.

ENGINE — load ONLY this exact CDN (sets global \`pc\`):
<script src="https://cdn.jsdelivr.net/npm/playcanvas@2.20.0/build/playcanvas.min.js"></script>

CRITICAL — WHAT MAKES GAMES BREAK (avoid every one):
- This engine build has NO physics engine (no ammo.js). NEVER use 'rigidbody' or 'collision' components, app.systems.rigidbody, or pc.RIGIDBODY_* — they silently do nothing. Do ALL movement and collision YOURSELF with vector math: move entities by setting position each frame; detect hits with distance/AABB checks (e.g. a.getPosition().distance(b.getPosition()) < r, or compare x/z extents).
- Use only APIs that exist: entities + 'camera','light','render' components; pc.StandardMaterial; app.keyboard.isPressed(pc.KEY_*); app.mouse / pc.MOUSEBUTTON_*; app.on('update', dt => ...). Don't invent asset pipelines.
- Guard every external image load with a solid-color fallback so the game ALWAYS renders even offline.

BOOT exactly like this, then build the game:
  const canvas=document.getElementById('app');
  const app=new pc.Application(canvas,{mouse:new pc.Mouse(canvas),keyboard:new pc.Keyboard(window),touch:new pc.TouchDevice(canvas)});
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW); app.setCanvasResolution(pc.RESOLUTION_AUTO);
  window.addEventListener('resize',()=>app.resizeCanvas());
  // camera (clearColor sky), directional light + a bit of ambient (app.scene.ambientLight), ground, player, entities, materials, HUD logic
  app.on('update',(dt)=>{ /* input → movement → spawning → collision → score → win/lose */ });
  app.start();

RICH VISUALS — USE REAL IMAGES FROM THE WEB (this is what makes it look killer, not barren):
- Generate textures/sprites/skies on the fly from Pollinations (free, CORS-enabled). URL pattern:
    https://image.pollinations.ai/prompt/<URL-ENCODED VIVID DESCRIPTION>?width=512&height=512&nologo=true
  e.g. seamless grass, sci-fi metal panel, asteroid rock, wood crate, neon city wall, a coin sprite.
- Apply with crossOrigin so WebGL accepts it, with a colored fallback:
    function webTex(url){ const t=new pc.Texture(app.graphicsDevice,{addressU:pc.ADDRESS_REPEAT,addressV:pc.ADDRESS_REPEAT}); const img=new Image(); img.crossOrigin='anonymous'; img.onload=()=>{t.setSource(img);}; img.src=url; return t; }
    const m=new pc.StandardMaterial(); m.diffuse=new pc.Color(0.4,0.6,0.3); m.diffuseMap=webTex('https://image.pollinations.ai/prompt/seamless%20lush%20grass%20texture?width=512&height=512&nologo=true'); m.update();
- Optional sky: a large inverted box/sphere around the scene textured with a Pollinations sky, or a tasteful gradient clearColor. Keep performance smooth.

THE GAME ITSELF — build it like a REAL TITLE, not an arcade demo. Match the genre the user names and deliver its full structure:
- FPS (Call of Duty-class ask): pointer-lock mouselook (canvas.requestPointerLock on click, mousemove aim) + WASD strafing, a visible first-person weapon (simple 3D boxes composing a gun in front of the camera), crosshair, hitscan shooting with muzzle flash, magazine + reload (R), health + regen, 6-12 enemy soldiers with real AI states (patrol → chase → strafe-and-shoot), damage indicators, kill feed, score/killstreak, waves or objectives, minimap (top-right 2D canvas dots), round win/lose.
- SPORTS SIM (NBA/NFL/FIFA-class ask): a real match — two TEAMS of AI players with roles (your controlled athlete highlighted + AI teammates who position, defenders who mark/steal), ball physics you write (carry, pass with aimed direction, shoot/kick with power, interceptions), REAL rules for the sport (basketball: 2/3-pointers, shot clock, quarters; football: downs & yards-to-go, snaps, play selection of 3-4 plays, touchdowns + field goals), scoreboard with game clock + quarter/half, play-by-play text feed, halftime and final screens with stats.
- RACING: lap-based circuit with AI cars, checkpoints, lap times/best lap, position tracker, speed HUD.
- Anything else: pick the closest full-structure genre and deliver ALL of its systems.
- ALWAYS: a TITLE SCREEN (game name, styled, Start button + controls), pause (Esc/P), a proper END screen (stats + Restart), difficulty ramp, and localStorage high score/best. Structure code as gameState machine ('menu'|'playing'|'paused'|'over').
- SOUND: procedural WebAudio (no files) — a tiny synth helper for shots/bounces/whistles/scores/engine hum, muted until first user gesture.
- Scale ambition to the ask: a named-franchise-class request deserves 700-1200+ lines of dense game code with every system above. Pick fitting, complete mechanics; real difficulty curve, spawning, scoring, win AND lose states, and a restart.
- Controls work on desktop AND mobile: WASD+arrows via app.keyboard.isPressed, AND pointer/touch (tap/drag/hold) so it plays on a phone. Show the controls on screen.
- Juice: smooth movement (lerp), particle-ish feedback (scale/flash on hit), a sky, lit materials, a moving camera that follows the player. 60fps — only transform/material updates in the loop.
- HUD as absolute-positioned HTML over the canvas: score, lives/timer, a one-line "how to play", and a Restart button that fully resets state. A start overlay and a game-over overlay with the score.

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

const SYSTEM_LOGO = `You art-direct a logo like a Pentagram partner. Nalu's design engine RENDERS the vector art in code and a diffusion model paints the pictorial mark, so you do NOT draw SVG — you return the brand direction as compact JSON.

- "name": the brand name EXACTLY as the user gives it — verbatim, unchanged. NEVER invent, translate, expand, or append words ("Acme" stays "Acme", never "Acme Get"). If the request gives no explicit name, choose ONE clean, real-sounding 1–2 word name (never a phrase or random words).
- "initials": 1–2 uppercase letters for the monogram — two-word names → first letter of each; one-word names → just the first letter.
- "serif": true if the brand should feel classic / elegant / luxury / editorial / heritage; false for modern / tech / clean / minimal / startup.
- "colors": ["#primary","#accent"] — a refined, professional palette (deep, confident, timeless; no neon, no more than 2).
- "colorNames": plain-English names for those exact colors, in order (e.g. ["deep midnight navy","antique gold"]) — a diffusion model reads these, so make them vivid and unambiguous.
- "concept": a ≤6-word vibe label.
- "symbol": THE key creative decision — describe ONE specific, ownable pictorial mark concept for this exact brand in 6-14 words (what a designer would sketch: the object(s), geometry, and arrangement). Think Apple's apple, Twitter's bird, Shell's shell: simple, memorable, meaningful to the business. E.g. for a coastal coffee brand: "a cresting wave curling into a coffee bean". Never generic ("abstract shape", "geometric design"); name real recognizable forms.

Output ONLY this minified JSON — no markdown, no <think>, no SVG, no prose:
{"name":"Acme","initials":"A","serif":false,"colors":["#0F1B2D","#AF8C56"],"colorNames":["deep midnight navy","antique gold"],"concept":"modern geometric","symbol":"an origami falcon folded from three sharp triangles"}`

const SYSTEM_SHOPPING = `You are an expert interior designer & personal shopper. Build a CURATED, real-world shopping list for the user's request (a room, a whole house, an outfit, a setup — anything they want to buy).

Be genuinely useful and specific, like a great designer who shops for a living:
- Pick REAL, recognizable products and well-known retailers (IKEA, Article, West Elm, CB2, Wayfair, Crate & Barrel, Pottery Barn, Amazon, Target, Home Depot, Lowe's, Floyd, Burrow, AllModern, Rejuvenation, etc.). Use realistic current-market PRICES.
- Cover everything needed so the result feels complete and cohesive — furniture, lighting, rugs, textiles, storage, decor, plants — grouped by category. Aim for 8–16 items.
- Each item: a concrete product name, the category, a one-line reason it was chosen / what to look for, a realistic price (or tight range), and a suggested retailer. Add a short "query" = the exact words to search to find it (the app builds the store links from this — do NOT write URLs).
- Keep a coherent style and a sensible total. If the user gave a budget, respect it and note the running total.

Output ONLY one minified JSON object — no markdown fences, no <think>, no prose:
{"title":"Modern Living Room","summary":"one short line on the look & vibe","budget":"~$4,200 total","items":[{"name":"Sven 88\\" Sofa","category":"Seating","reason":"low-profile mid-century sofa, durable boucle","price":"$1,399","retailer":"Article","query":"Article Sven 88 sofa boucle"}]}

Rules: every item MUST have name, category, price, and query. Keep names real and searchable. 8–16 items. No emojis.`

const SYSTEM_PALETTE = `You are an elite design director — a world-class colorist AND typographer (Pentagram/Collins caliber) with deep UI/UX judgment. From the user's description, design their color-and-type direction and give them REAL CHOICES.

Output ONLY one minified JSON object — no markdown fences, no <think>, no prose — of this exact shape:
{"name":"Palette Name","description":"one short mood line","fonts":{"heading":"Google Font family","body":"Google Font family"},"colors":[{"role":"primary","name":"Deep Ocean","hex":"#0B3D5C","usage":"headers, primary buttons"}],
 "options":[{"name":"Direction name","description":"how this direction FEELS and when to choose it","fonts":{"heading":"...","body":"..."},"colors":[...same shape...]}]}

Rules:
- The TOP-LEVEL palette is your recommended direction. "options" MUST contain 3 ADDITIONAL distinct directions (different moods — e.g. one bolder, one calmer, one unexpected) so the user can pick; every option is complete (5-8 colors + fonts).
- 5 to 8 colors each. "role" is one of: "primary","secondary","accent","neutral","background","surface","success","warning","danger". Always include primary, accent, background, and a text-capable neutral.
- "hex" MUST be a valid 6-digit hex like "#0B3D5C" for EVERY color — never rgb/hsl.
- CRAFT: honor the user's words precisely (if they say "warm terracotta, no blue", obey); build 60-30-10 balance; body-text contrast vs background ≥ WCAG AA (4.5:1); accents that pass 3:1 on background.
- FONTS: real Google Fonts only; pair a distinctive heading face with a highly readable body face; match the mood (editorial serif vs geometric sans vs humanist).
- "name" is an evocative color name; "usage" says exactly where it goes in a UI (nav, CTA, cards, borders).
- Output ONLY the JSON object.`

const SYSTEM_BRAND = `You are an award-winning brand strategist and designer (Pentagram / Collins caliber). You produce ONLY the STRUCTURED CONTENT for a brand guidelines book — never HTML, never CSS, never layout. A fixed, hand-crafted template renders your JSON into a polished multi-page book, so your sole job is rich, specific, real editorial CONTENT.

Output ONLY one minified JSON object — no markdown fences, no <think>, no prose, no comments — of EXACTLY this shape:

{"brand":{"name":"","tagline":"","mission":"","vision":"","positioning":"","values":[{"label":"","description":""}],"voice":[{"label":"","description":""}]},"palette":[{"role":"primary","name":"","hex":"#RRGGBB","usage":""}],"typography":{"heading":{"family":"","usage":""},"body":{"family":"","usage":""},"scale":["Display","Heading 1","Heading 2","Heading 3","Body","Caption"]},"logo":{"direction":"","clearspace":"","minSize":""},"dos":[""],"donts":[""]}

THE SUBJECT — get this right first: if the user NAMES a company or brand (e.g. "brand guidelines for Aurora"), THAT is the brand — use its exact name throughout every field and never rename or replace it with Nalu or anything else. ONLY when no company is named at all, the brand defaults to Nalu — a modern AI company at n4lu.ai ("Nalu" means "wave" in Hawaiian; oceanic, calm, intelligent, premium). Never invent an unrelated company name.

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
- shape types: "rect"(x,y,w,h), "line"(x1,y1,x2,y2), "circle"(cx,cy,r), "ellipse"(cx,cy,rx,ry) — pools/round tables, "polyline"(points:[[x,y]]) — driveways/walks, "text"(x,y,text), "door"(x,y,w,swing:"left"|"right",dir:"h"|"v"), "window"(x,y,w,dir:"h"|"v"), "tree"(cx,cy,r). Optional "label" + integer "stroke" (1=thin interior, 3=thick exterior).
- EVERY door and window MUST include "dir": "h" when it sits in a horizontal wall (opening runs left-right), "v" when it sits in a vertical wall (opening runs up-down) — and its x,y MUST lie ON a wall line (a room edge or the exterior wall), never floating inside a room. For "v" doors/windows, w is the opening's vertical length.
- CALL OUT MATERIALS in annotations ("Calacatta marble counter", "white oak floor", "slate patio"). 4–8 annotations per floor.
- DIMENSION GENEROUSLY: overall dims on ≥2 sides PLUS internal room dims, proper notation (12'-6", Ø2.5", R3).

CODE-ACCURATE — dimensions must survive a builder's red pen:
- Every dimension string must ADD UP: room widths along a wall + wall thicknesses = the overall dimension on that side. Text room sizes (LIVING 14'×18') must MATCH the drawn rectangle's w×h.
- Livable minimums: bedrooms ≥ 10'×10' with a closet AND an egress window; hallways ≥ 3'-6" wide; interior doors 2'-6"–3'-0", entry 3'-0"; toilet centered ≥ 15" from any side wall (draw the clearance); kitchen aisles ≥ 42"; stairs 3'-0" wide min at ~10" tread — a straight run of 13–16 treads needs ≈ 11–14 ft, DRAW the stair that long, labeled "UP"/"DN" with tread lines.
- Structure reads true: upper floors bear on walls below (stack bearing lines); plumbing stacks vertically (baths over baths/kitchen); windows on exterior walls only; every habitable room gets at least one window.
- Include "scale" and a precise "title". Be geometrically consistent and to-scale. Output ONLY the JSON object.`

const DESIGN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// Fetch a Pollinations image server-side → data URL (retries, flux→turbo fallback).
async function fetchPollinations(url: string): Promise<string | null> {
  // Always use the FAST turbo model for baking (flux 1080px is too slow/queued to
  // reliably return inside the budget); it renders great at social sizes.
  const base = url.replace(/model=flux/i, 'model=turbo').replace(/\bmodel=[a-z]+\b/i, 'model=turbo')
  const turbo = /model=/i.test(base) ? base : base + (base.includes('?') ? '&' : '?') + 'model=turbo'
  for (let attempt = 0; attempt < 6; attempt++) {
    const u = turbo
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 25000)
      const r = await fetch(u, { headers: { 'User-Agent': DESIGN_UA }, signal: ctrl.signal })
      clearTimeout(t)
      const ct = r.headers.get('content-type') || ''
      if (r.ok && ct.startsWith('image/')) {
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > 1500) return `data:${ct};base64,${buf.toString('base64')}`
      }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1)))
  }
  return null
}

// Bake every Pollinations <img>/background image in the HTML into inline data
// URLs (parallel, capped). Makes carousel/poster images ALWAYS render on the
// client AND lets html2canvas export them (cross-origin URLs taint the canvas).
const BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
async function bakeImages(html: string, cap = 6): Promise<string> {
  const urls = [...new Set((html.match(/https:\/\/image\.pollinations\.ai\/prompt\/[^"'\s)]+/g) || []))].slice(0, cap)
  if (!urls.length) return html
  let out = html
  // Low concurrency (2 at a time) so Pollinations doesn't 429 the whole batch.
  const queue = [...urls]
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift() as string
      // sanitize: fix &amp;, strip control chars the model sometimes emits (%19 etc.)
      const clean = u.replace(/&amp;/g, '&').replace(/%1[0-9a-f]|%0[0-9a-f]/gi, '%20')
      const data = await fetchPollinations(clean)
      if (data) out = out.split(u).join(data)
    }
  }
  await Promise.all([worker(), worker()])
  // Any image that STILL failed to bake → a transparent pixel, so the slide's
  // background/gradient shows (never a gray box, never a CORS-tainting cross-
  // origin image that would break the PNG export).
  out = out.replace(/https:\/\/image\.pollinations\.ai\/prompt\/[^"'\s)]+/g, BLANK_PX)
  return out
}

function getSystemPrompt(kind: DesignKind): string {
  switch (kind) {
    case 'motion':
      return SYSTEM_MOTION
    case 'game':
      return SYSTEM_GAME
    case 'board':
      return SYSTEM_BOARD
    case 'webpage':
      return SYSTEM_HTML
    case 'poster':
      return SYSTEM_POSTER
    case 'carousel':
      return SYSTEM_CAROUSEL
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
  // The design function has a 300s budget, so HTML kinds get real room — an
  // 8.5k cap truncated full sites mid-tag (the #1 reason pages looked broken).
  if (kind === 'carousel') return 16000 // 5-8 designed slides + swipe logic + PNG export
  if (kind === 'game') return 22000 // a complete, polished, textured PlayCanvas game
  if (kind === 'webpage') return 15000 // rich multi-section site that FINISHES inside the 300s budget
  if (kind === 'board') return 15000 // dense executive breakdown board + SVG diagrams
  if (kind === 'poster') return 10000 // rich single-page composition
  if (kind === 'motion') return 11000 // a self-contained animated HyperFrame
  if (kind === 'blueprint') return 9000 // multi-floor, bounded
  if (kind === 'canvas') return 6000
  if (kind === 'logo') return 11000 // 3 options × (mark + lockup)
  if (kind === 'brand') return 14000 // full multi-page brand book — was truncating at 5000
  if (kind === 'shopping') return 4500 // a curated list of items
  if (HTML_KINDS.has(kind)) return 9000
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
  return `\n\nACTIVE BRAND KIT — THIS IS THE PALETTE FOR THIS DESIGN. Use these exact colors as the actual color scheme and IGNORE/OVERRIDE any default "house" palette (e.g. the navy/gold) described in the instructions above — build the entire design around these instead. Only deviate if the user's request above explicitly names different colors, OR this is a site for a real named company whose real brand colors you researched.${
    primary ? ` Primary ${primary};` : ''
  }${accent ? ` accent ${accent};` : ''}${dark ? ` dark ${dark};` : ''}${text ? ` body text ${text};` : ''}${
    fonts ? ` typography: ${fonts}.` : ''
  } Apply primary as the dominant brand color, accent for highlights/CTAs/hairlines, dark for deep sections, and keep strong contrast + legibility throughout.`
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
  // Drop any trailing prose the model added AFTER the document ("This animation
  // features…") — otherwise the doc doesn't END with </html> and downstream
  // truncation repair skips it (</html> exists mid-string).
  const end = t.toLowerCase().lastIndexOf('</html>')
  if (end !== -1) t = t.slice(0, end + '</html>'.length)
  return t.trim()
}

// True when the model's HTML was cut off by the token limit (no real </html>).
function isTruncatedHtml(html: string): boolean {
  return !/<\/html>\s*$/i.test(html.trim())
}

// Repair a TRUNCATED HTML document so it still renders cleanly: drop a dangling
// partial tag, then balance any open <style>/<script> and close <body>/<html>.
// Browsers auto-close stray block tags, so the completed-up-to-the-cut page shows.
function completeHtml(raw: string): string {
  let t = raw.replace(/\s+$/, '')
  if (/<\/html>\s*$/i.test(t)) return t
  // cut a trailing unterminated tag like `<div class="he` (last '<' after last '>')
  const lastLt = t.lastIndexOf('<')
  const lastGt = t.lastIndexOf('>')
  if (lastLt > lastGt) t = t.slice(0, lastLt).replace(/\s+$/, '')
  const count = (re: RegExp) => (t.match(re) || []).length
  // close an unterminated <style> / <script> (else it swallows the closers)
  if (count(/<style[\s>]/gi) > count(/<\/style>/gi)) t += '\n</style>'
  if (count(/<script[\s>]/gi) > count(/<\/script>/gi)) t += '\n</script>'
  if (!/<\/body>/i.test(t)) t += '\n</body>'
  if (!/<\/html>/i.test(t)) t += '\n</html>'
  return t
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
      const fontsOf = (v: unknown) => {
        const f = v as { heading?: unknown; body?: unknown } | undefined
        const heading = typeof f?.heading === 'string' ? f.heading : ''
        const body = typeof f?.body === 'string' ? f.body : ''
        return heading || body ? { heading, body } : undefined
      }
      // pickable alternative directions (each a complete palette + fonts)
      const options = (Array.isArray((p as { options?: unknown[] }).options) ? (p as { options: unknown[] }).options : [])
        .map((o) => {
          const oo = o as { name?: unknown; description?: unknown; colors?: unknown; fonts?: unknown }
          const oc = cleanPalette(oo.colors)
          if (!oc) return null
          return {
            name: typeof oo.name === 'string' ? oo.name : 'Direction',
            description: typeof oo.description === 'string' ? oo.description : '',
            fonts: fontsOf(oo.fonts),
            colors: oc,
          }
        })
        .filter(Boolean)
        .slice(0, 5)
      return {
        kind,
        name: typeof p.name === 'string' && p.name ? p.name : 'Nalu Studio',
        description: typeof p.description === 'string' ? p.description : '',
        fonts: fontsOf((p as { fonts?: unknown }).fonts),
        colors,
        ...(options.length ? { options } : {}),
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
        colorNames: Array.isArray(p.colorNames)
          ? (p.colorNames as unknown[]).filter((c): c is string => typeof c === 'string' && !!c.trim()).map((c) => c.trim().slice(0, 40)).slice(0, 4)
          : [],
        concept: str(p.concept),
        symbol: str(p.symbol).slice(0, 140),
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
    case 'game':
    case 'carousel': {
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
      const arr = (v: unknown) => (Array.isArray(v) ? v : [])
      const th = (p.theme || {}) as Record<string, unknown>
      const hexOr = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : d)
      const slides = arr(p.slides)
        .map((sl) => {
          const o = sl as Record<string, unknown>
          const headline = str(o.headline)
          if (!headline) return null
          return {
            kind: ['cover', 'point', 'cta'].includes(str(o.kind)) ? str(o.kind) : 'point',
            badge: str(o.badge).slice(0, 6),
            headline: headline.slice(0, 120),
            sub: str(o.sub).slice(0, 160),
            body: arr(o.body).map((b) => str(b)).filter(Boolean).slice(0, 3),
            img: str(o.img).slice(0, 300),
          }
        })
        .filter(Boolean)
        .slice(0, 10)
      if (slides.length < 2) return null
      return {
        kind,
        name: 'Nalu Post',
        platform: str(p.platform) || 'instagram',
        ratio: ['4:5', '9:16', '1:1'].includes(str(p.ratio)) ? str(p.ratio) : '4:5',
        handle: str(p.handle),
        theme: {
          bg: hexOr(th.bg, '#4F46E5'),
          bg2: hexOr(th.bg2, hexOr(th.bg, '#7C3AED')),
          ink: hexOr(th.ink, '#FFFFFF'),
          accent: hexOr(th.accent, '#FBBF24'),
          headingFont: str(th.headingFont) || 'Anton',
          bodyFont: str(th.bodyFont) || 'Inter',
        },
        slides,
        caption: str(p.caption),
        hashtags: arr(p.hashtags).map((h) => str(h)).filter((h) => h.startsWith('#')).slice(0, 12),
      }
    }
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

// ---------------------------------------------------------------------------
// Blueprint geometric validation — the model's floor plans MUST hold up to
// real drafting rules. We check them and, when violations exist, run ONE
// targeted repair pass with the specific errors (then clamp what remains).
// ---------------------------------------------------------------------------
type BpShape = Record<string, unknown> & { type?: string; x?: number; y?: number; w?: number; h?: number; label?: string; dir?: string }
type BpFloor = { name?: string; viewBox?: { w?: number; h?: number }; shapes?: BpShape[] }

const FIXTURE_RE = /\b(island|fridge|refrigerator|range|stove|oven|dish|sink|toilet|wc|tub|bath(?!room)|shower|vanity|bed(?!room)|sofa|couch|table|desk|closet|wardrobe|washer|dryer|counter|cabinet|fireplace|stair|nightstand|dresser|car|parking|lawn|landscap|planter|deck|patio|pool|drive)/i
const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null)

// A "room" = a labeled rect big enough to be a space (not a fixture).
function bpRooms(f: BpFloor): Array<{ label: string; x: number; y: number; w: number; h: number }> {
  const out: Array<{ label: string; x: number; y: number; w: number; h: number }> = []
  for (const s of f.shapes || []) {
    if (s.type !== 'rect') continue
    const x = num(s.x), y = num(s.y), w = num(s.w), h = num(s.h)
    if (x == null || y == null || w == null || h == null) continue
    const label = typeof s.label === 'string' ? s.label : ''
    if (!label || FIXTURE_RE.test(label) || /exterior|property|residence|garage roof/i.test(label)) continue
    if (w * h < 15) continue // too small to be a room
    out.push({ label, x, y, w, h })
  }
  return out
}

/** Human-readable geometry violations for one blueprint payload. */
function blueprintIssues(payload: Record<string, unknown>): string[] {
  const issues: string[] = []
  const floors: BpFloor[] = Array.isArray(payload.floors)
    ? (payload.floors as BpFloor[])
    : [{ name: 'Plan', viewBox: payload.viewBox as { w?: number; h?: number }, shapes: payload.shapes as BpShape[] }]
  for (const f of floors) {
    const fname = f.name || 'floor'
    const vw = num(f.viewBox?.w) ?? 0
    const vh = num(f.viewBox?.h) ?? 0
    if (!vw || !vh) { issues.push(`${fname}: missing viewBox`); continue }
    // out-of-bounds shapes
    for (const s of f.shapes || []) {
      if (s.type === 'rect') {
        const x = num(s.x) ?? 0, y = num(s.y) ?? 0, w = num(s.w) ?? 0, h = num(s.h) ?? 0
        if (x < -0.01 || y < -0.01 || x + w > vw + 0.51 || y + h > vh + 0.51)
          issues.push(`${fname}: "${s.label || 'rect'}" (${x},${y} ${w}x${h}) extends outside the ${vw}x${vh} viewBox`)
      }
    }
    // overlapping rooms (allow up to 1ft shared-wall tolerance)
    const rooms = bpRooms(f)
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i], b = rooms[j]
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ox > 1 && oy > 1) {
          issues.push(`${fname}: room "${a.label}" overlaps room "${b.label}" by ${ox.toFixed(1)}x${oy.toFixed(1)} ft — rooms must tile edge-to-edge, never overlap`)
        }
      }
    }
    // doors/windows must sit on a wall line (some room edge or the exterior)
    for (const s of f.shapes || []) {
      if (s.type !== 'door' && s.type !== 'window') continue
      const x = num(s.x) ?? 0, y = num(s.y) ?? 0
      const onEdge =
        [0, vw].some((e) => Math.abs(x - e) < 1.01) ||
        [0, vh].some((e) => Math.abs(y - e) < 1.01) ||
        rooms.some(
          (r) =>
            (Math.abs(y - r.y) < 1.01 || Math.abs(y - (r.y + r.h)) < 1.01) && x >= r.x - 1 && x <= r.x + r.w + 1,
        ) ||
        rooms.some(
          (r) =>
            (Math.abs(x - r.x) < 1.01 || Math.abs(x - (r.x + r.w)) < 1.01) && y >= r.y - 1 && y <= r.y + r.h + 1,
        )
      if (rooms.length && !onEdge) issues.push(`${fname}: ${s.type} at (${x},${y}) floats inside a room — every ${s.type} must sit ON a wall line`)
    }
  }
  return issues.slice(0, 14)
}

/** Deterministic cleanup for whatever the repair pass didn't fix: clamp
 *  out-of-bounds rects into the viewBox so nothing renders off-sheet. */
function clampBlueprint(payload: Record<string, unknown>): void {
  const floors: BpFloor[] = Array.isArray(payload.floors) ? (payload.floors as BpFloor[]) : []
  const all = floors.length ? floors : [{ viewBox: payload.viewBox as { w?: number }, shapes: payload.shapes as BpShape[] }]
  for (const f of all) {
    const vw = num(f.viewBox?.w), vh = num((f.viewBox as { h?: number })?.h)
    if (!vw || !vh) continue
    for (const s of f.shapes || []) {
      if (s.type !== 'rect') continue
      const x = num(s.x), y = num(s.y), w = num(s.w), h = num(s.h)
      if (x == null || y == null || w == null || h == null) continue
      s.x = Math.max(0, Math.min(x, vw))
      s.y = Math.max(0, Math.min(y, vh))
      s.w = Math.min(w, vw - (s.x as number))
      s.h = Math.min(h, vh - (s.y as number))
    }
  }
}

// ---------------------------------------------------------------------------
// Creative-director pass: a SHORT/generic webpage brief ("website for my
// bakery") is expanded into a rich, specific brief — subject-appropriate
// style, palette, page list, copy angles, imagery plan — so a one-liner
// yields the same calibre of site as a detailed spec. Best-effort.
// ---------------------------------------------------------------------------
const SYSTEM_EXPAND = `You are an award-winning creative director briefing a web designer. Expand the client's short ask into a specific, opinionated creative brief for a COMPLETE multi-page website. Be decisive — pick ONE direction that genuinely fits THIS business/subject (a bakery, a law firm, a skate brand, a SaaS all deserve different worlds — do NOT default to generic luxury).

Return 12-20 tight lines covering:
- Brand: name (invent a fitting one if none given), one-line positioning, tone of voice.
- Art direction: the style movement, palette (4-5 specific hex colors that suit the subject), display+body Google Font pairing, imagery mood.
- Pages: Home + 3-5 named pages, and for EACH page the sections it needs with the actual content angle (real menu categories, real service names, plausible prices, real neighborhood details — specific, never placeholder).
- Signature moment: one memorable WebGL/three.js hero effect in the brand's colors (particle field, flowing waves, floating geometry) — Nalu sites always ship one.
- Copy: the exact hero headline + tagline to use.

Plain text lines only — no markdown headers, no JSON, no preamble.`

async function expandBrief(prompt: string): Promise<string> {
  try {
    const brief = await chatComplete(
      [
        { role: 'system', content: SYSTEM_EXPAND },
        { role: 'user', content: prompt },
      ],
      { model: LLM_MODEL, maxTokens: 900, timeoutMs: 35000, retryPrimary: false, temperature: 0.8 },
    )
    const t = brief.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    return t.length > 80 ? t : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// WebGL guarantee: every generated WEBSITE ships a visible real-time scene.
// When the model designs its own (canvas + importmap) we keep it; when it
// skips it, we INJECT a self-contained, brand-colored three.js particle field
// as a full-site luminous overlay (pointer-events:none, blend-adaptive to
// light/dark pages, mouse parallax) — deterministic, not prompt-dependent.
// ---------------------------------------------------------------------------
function extractBrandHexes(html: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of html.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const h = m[1].toUpperCase()
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    if (lum > 0.93 || lum < 0.07 || sat < 24) continue // skip whites/blacks/grays
    if (!seen.has(h)) { seen.add(h); out.push('#' + h) }
    if (out.length >= 3) break
  }
  return out.length ? out : ['#AF8C56', '#5B9BFF', '#E4B96F']
}
function webglOverlaySnippet(colors: string[]): string {
  const cols = JSON.stringify(colors.slice(0, 3))
  return `
<canvas id="nalu-gl" style="position:fixed;inset:0;width:100vw;height:100vh;z-index:2147482000;pointer-events:none;mix-blend-mode:screen;opacity:.55"></canvas>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
<script type="module">
try {
  // A page may already carry its own importmap (only the first one wins) —
  // resolve 'three' through it, else fall back to a direct CDN URL import.
  const THREE = await import('three').catch(() => import('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js'));
  const cv = document.getElementById('nalu-gl');
  // adapt to the page: dark pages get luminous screen-blend particles, light
  // pages get deep multiply-blend particles — always visible, never blocking.
  const bg = getComputedStyle(document.body).backgroundColor.match(/\\d+/g) || [255,255,255];
  const light = (0.299*bg[0] + 0.587*bg[1] + 0.114*bg[2]) / 255 > 0.55;
  if (light) { cv.style.mixBlendMode = 'multiply'; cv.style.opacity = '.34'; }
  const renderer = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 100);
  cam.position.z = 15;
  // Duotone scroll-driven field: the camera travels THROUGH a deep particle
  // world as the page scrolls (scroll-driven WebGL storytelling), colors
  // blending between the two brand tones along the journey.
  const N = 2200, DEPTH = 90, pos = new Float32Array(N*3), col = new Float32Array(N*3), ph = new Float32Array(N);
  const palette = ${cols}.map(h => new THREE.Color(h));
  const cA = palette[0], cB = palette[1] || palette[0];
  for (let i = 0; i < N; i++) {
    pos[i*3] = (Math.random()-0.5)*40; pos[i*3+1] = (Math.random()-0.5)*22; pos[i*3+2] = -Math.random()*DEPTH + 15;
    const mix = Math.random();
    const c = cA.clone().lerp(cB, mix).multiplyScalar(light ? 0.72 : 1);
    col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b;
    ph[i] = Math.random()*Math.PI*2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.1, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
  scene.add(pts);
  let mx = 0, my = 0;
  addEventListener('pointermove', (e) => { mx = (e.clientX/innerWidth - 0.5); my = (e.clientY/innerHeight - 0.5); }, { passive: true });
  const fit = () => { renderer.setSize(innerWidth, innerHeight); cam.aspect = innerWidth/innerHeight; cam.updateProjectionMatrix(); };
  addEventListener('resize', fit); fit();
  let t = 0, last = 0, hidden = false, z = 15;
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; });
  const P = geo.attributes.position;
  const tick = (now) => {
    requestAnimationFrame(tick);
    if (hidden) return;
    const dt = Math.min(0.05, (now - last)/1000 || 0.016); last = now; t += dt;
    // scroll = journey: ease the camera through the depth of the field
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const target = 15 - (scrollY / max) * (DEPTH * 0.75);
    z += (target - z) * 0.06; cam.position.z = z;
    for (let i = 0; i < N; i++) {
      P.array[i*3+1] += Math.sin(t*0.7 + ph[i] + P.array[i*3]*0.25) * 0.004;
      P.array[i*3] += Math.cos(t*0.5 + ph[i]) * 0.002;
    }
    P.needsUpdate = true;
    pts.rotation.y += (mx*0.3 - pts.rotation.y) * 0.03;
    pts.rotation.x += (my*0.2 - pts.rotation.x) * 0.03;
    cam.rotation.z += ((scrollY/max)*0.15 - cam.rotation.z) * 0.02;
    renderer.render(scene, cam);
  };
  requestAnimationFrame(tick);
} catch (e) { /* transparent canvas is harmless — leave the page untouched */ }
</script>`
}
/** Guarantee a visible WebGL scene on a website: keep the model's own scene
 *  when it is trustworthy (complete build, real canvas markup), else inject
 *  the Nalu overlay before </body>. `force` (truncated build) always injects —
 *  a cut-off script never boots its canvas. */
function ensureWebgl(html: string, force = false): string {
  if (!force && /<canvas/i.test(html) && /importmap|three\.module|WebGLRenderer/i.test(html)) return html
  const snippet = webglOverlaySnippet(extractBrandHexes(html))
  // Inject at the TOP of <body> — appending before </body> can land inside an
  // UNCLOSED hidden container on a truncated build (display:none ancestor →
  // invisible canvas). Top-of-body is never inside anything.
  const m = html.match(/<body[^>]*>/i)
  if (m) return html.replace(m[0], m[0] + snippet)
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, snippet + '\n</body>')
  return html + snippet
}

// CONTENT-VISIBILITY FAILSAFE — the #1 "blank site" cause: a scroll-reveal
// script that died (truncation, a JS error) leaves every section at opacity:0
// so a fully-written page renders EMPTY. This watchdog force-reveals anything
// still invisible after ~700ms in the viewport; a working reveal script fires
// first, so real animations are untouched.
const REVEAL_FAILSAFE = `
<script>(function(){var seen=new WeakMap();function sweep(){var vh=innerHeight;var els=document.querySelectorAll('section,header,main,article,h1,h2,h3,p,li,img,a,div');for(var i=0;i<els.length;i++){var el=els[i];var r=el.getBoundingClientRect();if(r.top<vh&&r.bottom>0&&r.width>0){var o=parseFloat(getComputedStyle(el).opacity);if(o<0.05){var t=seen.get(el);if(!t){seen.set(el,Date.now())}else if(Date.now()-t>700){el.style.opacity='1';el.style.transform='none'}}}}}setInterval(sweep,350);addEventListener('load',sweep)})()</script>`
function ensureVisibleContent(html: string): string {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, REVEAL_FAILSAFE + '\n</body>')
  return html + REVEAL_FAILSAFE
}

// One model call with timeout + automatic provider failover (Tinker → HF router).
// Throws only if every provider fails, so the caller's retry still applies.
// HTML kinds want a higher temperature (creative); JSON kinds want low + JSON mode.
async function callModel(system: string, user: string, maxTokens: number, temperature: number, json: boolean): Promise<string> {
  return chatComplete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { model: LLM_MODEL, maxTokens, timeoutMs: 110000, retryPrimary: false, temperature, json },
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
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
  // Follow-up edit to an existing page: revise prevHtml instead of regenerating.
  const prevHtml =
    HTML_KINDS.has(kind) && typeof body.prevHtml === 'string' && body.prevHtml.length > 200
      ? body.prevHtml.slice(0, 180000)
      : ''
  const system = prevHtml ? SYSTEM_HTML_EDIT : getSystemPrompt(kind)
  // Vision analysis of an attached photo (board kind) — ground truth for the model.
  const analysis = typeof body.analysis === 'string' ? body.analysis.trim().slice(0, 12000) : ''
  // Web-ground real brands (brand book / site / logo for a named company) so the
  // output uses the ACTUAL brand, not a guess. Best-effort; '' if not applicable.
  const grounding = prevHtml ? '' : await researchSite(prompt, kind)
  // Creative-director expansion: a short/generic website ask becomes a rich,
  // subject-appropriate brief (specific pages, palette, copy) — so a one-liner
  // builds like a detailed spec. Skipped for detailed prompts and edits.
  const brief = kind === 'webpage' && !prevHtml && prompt.length < 200 ? await expandBrief(prompt) : ''

  // LIVE SOCIAL TREND RESEARCH — for a post/carousel, detect the platform and
  // research what is TRENDING and working on it RIGHT NOW, then feed that in so
  // the post rides current aesthetics/formats (not last-year's playbook).
  let trendBrief = ''
  if (kind === 'carousel' && !prevHtml) {
    const P: Array<[RegExp, string]> = [
      [/\btiktok\b/i, 'TikTok'], [/\b(reels?|instagram|\big\b)\b/i, 'Instagram'], [/\blinkedin\b/i, 'LinkedIn'],
      [/\bpinterest\b/i, 'Pinterest'], [/\bthreads\b/i, 'Threads'], [/\b(x |twitter)\b/i, 'X (Twitter)'], [/\bfacebook\b/i, 'Facebook'],
    ]
    const platform = (P.find(([re]) => re.test(prompt)) || [null, 'Instagram'])[1]
    const year = new Date().getFullYear()
    try {
      const r = await research(`${platform} viral post trends best practices ${year} what is working now hooks aesthetics formats hashtags`, 3, 'social')
      if (r?.text) trendBrief = `\n\n----\nLIVE ${platform.toUpperCase()} TRENDS (${year} — research; apply the CURRENT winning formats, aesthetics, hooks, hashtags and posting norms so this post can reach the top of ${platform} fast; ignore anything off-topic):\n${r.text.slice(0, 5000)}`
    } catch { /* research is best-effort */ }
  }
  // Follow-up edit to an existing blueprint: revise the JSON instead of restarting.
  const prevBlueprint =
    kind === 'blueprint' && typeof body.prevBlueprint === 'string' && body.prevBlueprint.length > 50
      ? body.prevBlueprint.slice(0, 60000)
      : ''
  const whoLine = identityBlock(await identityForRequest(req).catch(() => null))
  const user =
    (whoLine ? whoLine + '\n\n----\n' : '') +
    (grounding ? grounding + '\n\n----\n\nThe request:\n' : '') +
    prompt +
    (prevBlueprint ? `\n\n----\nCURRENT BLUEPRINT JSON (apply the change above to THIS plan — keep everything not mentioned exactly as it is; output the complete updated JSON in the same schema):\n${prevBlueprint}` : '') +
    (analysis ? `\n\n----\nVISUAL ANALYSIS OF THE ATTACHED PHOTO (ground truth — build the board from this):\n${analysis}` : '') +
    (brief ? `\n\n----\nCREATIVE BRIEF (a creative director expanded the ask above — execute this direction fully; the user's own words still win any conflict):\n${brief}` : '') +
    trendBrief +
    (prevHtml ? `\n\n----\nCURRENT PAGE (revise this exact document per the request above; output the complete updated file):\n${prevHtml}` : '') +
    brandHint(body.brand, kind) +
    designSystemHint(prompt, kind, typeof body.system === 'string' ? body.system : undefined)
  const maxTokens = maxTokensFor(kind)
  const quota = await reserveStudioQuota(req, 'design')
  if (!quota.ok) {
    res.status(429).json({ error: studioLimitMessage('design', quota) })
    return
  }
  let succeeded = false
  try {
    if (HTML_KINDS.has(kind)) {
      // ONE generously-budgeted attempt (a full site needs ~150-200s of writing),
      // then a smaller fallback attempt — both sized so the function always
      // answers inside Vercel's 300s window; completeHtml repairs a rare cutoff.
      const t0 = Date.now()
      const elapsed = () => Date.now() - t0
      let best = ''
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 2 && !best; attempt++) {
        let html = ''
        try {
          const budget = attempt === 0
            ? { maxTokens, timeoutMs: 215000 }
            : { maxTokens: Math.min(maxTokens, 10000), timeoutMs: 90000 }
          html = cleanHtml(
            await chatComplete(
              [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              { model: LLM_MODEL, retryPrimary: false, temperature: 0.8, ...budget },
            ),
          )
        } catch (e) {
          lastErr = e
          continue
        }
        if (!html || !/<html|<!doctype|<body|<div/i.test(html)) continue
        if (!isTruncatedHtml(html)) { best = html; break } // complete — ship it
        if (html.length > best.length) best = html // keep the longest partial
      }
      if (!best) {
        if (lastErr) { res.status(502).json({ error: `Design upstream error: ${(lastErr as Error).message}` }); return }
        res.status(502).json({ error: 'Could not build the design. Try rephrasing.' })
        return
      }
      // AUTO-FINISH: a build cut off by the token ceiling gets ONE continuation
      // pass (when enough of the 300s budget remains) — unfinished builds
      // finish server-side whenever possible; the client "Finish build" button
      // covers the rest.
      if (best && isTruncatedHtml(best) && elapsed() < 200000) {
        try {
          const cont = await chatComplete(
            [
              { role: 'system', content: system },
              { role: 'user', content: user },
              { role: 'assistant', content: best },
              { role: 'user', content: 'Your HTML was cut off mid-output. Continue EXACTLY where it stopped — output ONLY the remaining HTML (no repetition, no fences, no commentary), all the way through the final </html>.' },
            ],
            { model: LLM_MODEL, maxTokens: 6000, timeoutMs: 60000, retryPrimary: false, temperature: 0.6 },
          )
          const tail = cont.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '')
          if (tail && !/<!doctype/i.test(tail.slice(0, 200))) best = best + tail
        } catch {
          /* keep the partial — completeHtml repairs it below */
        }
      }
      // ANTI-SKELETON ENFORCEMENT: a website must arrive fully baked AND
      // complete. If the page is still truncated (continuation failed) OR reads
      // thin (little real copy), ONE rescue pass completes + expands it —
      // checked, not just prompted.
      if (kind === 'webpage' && best && elapsed() < 205000) {
        const words = best
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .split(/\s+/)
          .filter(Boolean).length
        if (words < 450 || isTruncatedHtml(best)) {
          try {
            const richer = cleanHtml(
              await chatComplete(
                [
                  { role: 'system', content: SYSTEM_HTML_EDIT },
                  {
                    role: 'user',
                    content: `This site is UNFINISHED (${words} words of real copy${isTruncatedHtml(best) ? ', build cut off mid-generation' : ''} — a skeleton). Deliver the FULLY BAKED version: complete every cut-off or unfinished part, expand every thin section with complete, genuinely written content (real items, prices, descriptions, bios, FAQ answers), keep the design/structure/interactivity that already exists, and output the COMPLETE page through </html>.\n\n----\nCURRENT PAGE:\n${completeHtml(best).slice(0, 150000)}`,
                  },
                ],
                { model: LLM_MODEL, maxTokens: Math.min(maxTokens, 15000), timeoutMs: 90000, retryPrimary: false, temperature: 0.7 },
              ),
            )
            if (richer && /<html|<!doctype/i.test(richer) && richer.length > best.length * 0.8) best = richer
          } catch {
            /* keep the original */
          }
        }
      }
      // Flag a repaired (mid-generation cutoff) page so the client can offer
      // "Finish build" — an unfinished build can always still be finished.
      const truncated = isTruncatedHtml(best)
      let html = completeHtml(best)
      // WEBGL GUARANTEE — every website ships a visible real-time scene: the
      // model's own hero scene when it built one COMPLETELY, else the injected
      // Nalu brand-colored particle overlay (deterministic, not prompt-luck).
      if (kind === 'webpage') html = ensureWebgl(html, truncated)
      // NEVER a blank page: force-reveal content a broken reveal script left hidden.
      if (kind === 'webpage' || kind === 'board') html = ensureVisibleContent(html)
      // Carousels/posters: bake Pollinations images into data URLs so they ALWAYS
      // show and export cleanly via html2canvas (no gray boxes, no CORS taint).
      if (kind === 'carousel' || kind === 'poster') html = await bakeImages(html, 6)
      // webpage stays exactly { html, name } for backward compatibility; poster
      // adds kind so the client can route, html shape is identical.
      succeeded = true
      if (kind === 'webpage') {
        res.status(200).json({ html, name: 'Nalu Design', ...(truncated ? { truncated: true } : {}) })
      } else {
        res.status(200).json({ kind, html, name: 'Nalu Design', ...(truncated ? { truncated: true } : {}) })
      }
      return
    }

    // JSON kinds (brand/canvas/palette/blueprint/logo/shopping): low temp + native
    // JSON mode. RETRY a few times — DeepSeek occasionally emits unparseable JSON,
    // and (unlike HTML) there's no partial to repair, so ONE bad roll was a hard
    // failure. This is exactly why logos intermittently "wouldn't generate."
    let content = ''
    let jsonOut: Record<string, unknown> | null = null
    for (let attempt = 0; attempt < 5 && !jsonOut; attempt++) {
      try {
        content = await callModel(system, user, maxTokens, attempt === 0 ? 0.3 : 0.5, true)
      } catch { continue }
      const got = kind === 'brand' ? extractJson(content) : buildJsonPayload(kind, content)
      if (got && typeof got === 'object') jsonOut = got as Record<string, unknown>
    }

    // brand: the model returns structured CONTENT; we render the fixed book.
    if (kind === 'brand') {
      if (!jsonOut) {
        res.status(502).json({ error: 'Could not build the brand book. Try rephrasing.' })
        return
      }
      const html = buildBrandBookHtml(jsonOut)
      succeeded = true
      res.status(200).json({ kind: 'brand', html, name: 'Nalu Studio' })
      return
    }

    // JSON kinds: canvas | palette | blueprint | logo | shopping.
    let payload = jsonOut
    // Logos must NEVER fail: if the model couldn't produce valid JSON after the
    // retries, synthesize a clean, valid brand direction from the prompt so a logo
    // ALWAYS renders (the client draws the marks + generates the images).
    if (!payload && kind === 'logo') {
      const raw = String(prompt || '').trim()
      const m = raw.match(/(?:for|called|named|brand[:\s]+)\s+([A-Za-z][\w&.'-]*(?:\s+[A-Za-z][\w&.'-]*){0,2})/i)
      let nm = (m ? m[1] : raw.split(/[\s,.]+/).filter(Boolean).slice(0, 2).join(' ') || 'Brand').replace(/[^\w\s&.'-]/g, '').trim() || 'Brand'
      nm = nm.replace(/\b(a|an|the|logo|for|my|brand|company|startup)\b/gi, '').replace(/\s+/g, ' ').trim() || 'Brand'
      const words = nm.split(/\s+/).filter(Boolean)
      const initials = (words.length >= 2 ? words[0][0] + words[1][0] : nm.slice(0, 1)).toUpperCase()
      payload = {
        kind: 'logo', name: nm, initials,
        serif: /luxury|elegant|law|estate|heritage|classic|boutique|editorial|fashion/i.test(raw),
        colors: ['#0F1B2D', '#AF8C56'], colorNames: ['deep midnight navy', 'antique gold'],
        concept: 'refined geometric', symbol: `an abstract geometric emblem evoking "${nm}"`,
      }
    }
    if (!payload) {
      res.status(502).json({ error: 'Could not build the design. Try rephrasing.' })
      return
    }
    // Blueprints get a real drafting check: geometry violations (overlapping
    // rooms, floating doors, off-sheet shapes) trigger ONE targeted repair
    // pass with the exact errors; whatever remains is clamped deterministically.
    if (kind === 'blueprint') {
      const issues = blueprintIssues(payload)
      if (issues.length) {
        try {
          const fixed = await callModel(
            SYSTEM_BLUEPRINT,
            `${user}\n\n----\nYOU ALREADY DREW THIS PLAN, but a drafting review found these GEOMETRY ERRORS:\n- ${issues.join('\n- ')}\n\nRedraw the COMPLETE corrected JSON (same title/floors/detail level), fixing every listed error: rooms tile edge-to-edge with no overlaps, every shape inside its viewBox, every door/window ON a wall line with the right "dir". Output ONLY the JSON.\n\nPrevious JSON:\n${JSON.stringify(payload).slice(0, 30000)}`,
            maxTokens,
            0.2,
            true,
          )
          const repaired = buildJsonPayload(kind, fixed)
          if (repaired && blueprintIssues(repaired).length < issues.length) payload = repaired
        } catch {
          /* keep the original — clamp below */
        }
      }
      clampBlueprint(payload)
    }
    // Carousel: bake each slide's image prompt into a reliable data URL so photos
    // ALWAYS show and export — never a broken/slow client-side request.
    if (kind === 'carousel' && payload && Array.isArray((payload as { slides?: unknown[] }).slides)) {
      const pc = payload as { ratio?: string; slides: Array<{ img?: string }> }
      const [w, h] = pc.ratio === '9:16' ? [720, 1280] : pc.ratio === '1:1' ? [900, 900] : [720, 900]
      const withImg = pc.slides.filter((sl) => sl.img && sl.img.trim()).slice(0, 3)
      // limit total images; low concurrency to dodge 429
      const queue = [...withImg]
      const work = async () => {
        while (queue.length) {
          const sl = queue.shift() as { img?: string }
          const scene = encodeURIComponent((sl.img || '').replace(/[%\x00-\x1f]/g, ' ').slice(0, 200))
          const url = `https://image.pollinations.ai/prompt/${scene}?width=${w}&height=${h}&nologo=true&model=turbo&seed=7`
          const data = await fetchPollinations(url)
          sl.img = data || '' // failed → empty = clean type slide (never a gray box)
        }
      }
      await Promise.all([work(), work()])
      // any slide whose image did not bake into a data URL → clear it (a raw
      // text prompt must never become a broken <img>); the slide renders clean.
      for (const sl of pc.slides) if (sl.img && !sl.img.startsWith("data:image")) sl.img = ""
    }
    succeeded = true
    res.status(200).json(payload)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'design error' })
  } finally {
    if (!succeeded) await quota.release()
  }
}
