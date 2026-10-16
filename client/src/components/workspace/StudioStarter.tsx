import { useState } from 'react'
import { ArrowRight, ArrowUpRight, Pause, Play, Sparkles } from 'lucide-react'
import type { Tool } from './StudioPanel'
import './websiteStarter.css'
import './studioStarter.css'

type Example = { title: string; description: string; detail: string; brief: string; style?: string }
const EXAMPLES: Record<string, Example> = {
  logo: { title: 'A small mark.\nA big first impression.', description: 'Give your idea a recognizable signature. Start with a name, a mood, and what makes it different.', detail: 'Primary mark · alternate lockup', brief: 'Aster, an independent botanical skincare brand. A simple botanical vector mark, refined wordmark, and a warm olive and cream palette', style: 'minimal' },
  palette: { title: 'Set the tone.\nFind your colors.', description: 'Build a palette that feels like you, from the quiet backgrounds to the accents that stand out.', detail: 'Five colors · a sample application', brief: 'a calm coastal wellness brand, with deep pine, sage, warm cream, sand, and a muted terracotta accent; include hex codes and accessible text pairings' },
  brand: { title: 'One identity.\nEvery little detail.', description: 'Bring your logo, colors, typography, and voice together in a brand book made to be used.', detail: 'Cover · identity · typography', brief: 'Aster, a botanical skincare brand: a complete brand book with logo usage, olive and cream colors, elegant typography, photography direction, and a warm, honest tone of voice', style: 'editorial' },
  blueprint: { title: 'Make room\nfor your vision.', description: 'Turn the way you want to live into a clear floor plan. Describe the rooms, dimensions, and flow.', detail: 'Illustrative floor plan · top view', brief: 'a single-story two-bedroom retreat, approximately 10 by 7 meters, with an open living and dining room, a kitchen, one bathroom, and a garden-facing entrance' },
  walkthrough: { title: 'Step inside\nyour next space.', description: 'Imagine the light, materials, and furniture before you walk through a room of your own.', detail: 'Illustrative furnished room', brief: 'a sunlit apartment with oak floors, cream walls, a sage sofa, a round coffee table, a large window, and indoor plants; create a furnished 3D walkthrough' },
  motion: { title: 'Give your\nideas a little life.', description: 'Set a name, title, or message in motion with a reveal that feels intentional from the first frame.', detail: 'Animated title study', brief: 'an elegant looping title reveal for Aster, a botanical brand: cream lettering, an olive background, a slowly rotating botanical emblem, and a soft entrance', style: 'minimal' },
  game: { title: 'Dream it.\nThen play it.', description: 'Choose a world, a goal, and a challenge. Nalu turns your idea into a game you can actually play.', detail: 'Illustrative game scene', brief: 'a colorful island-hopping game with a small explorer, floating platforms, collectible golden gems, a score counter, and keyboard plus touch controls' },
  poster: { title: 'Make it\nimpossible to miss.', description: 'Give an event or an idea a bold visual voice, with expressive type and a composition that holds attention.', detail: 'Event poster · print-inspired layout', brief: 'a poster for Solstice, an outdoor jazz festival on June 21 at the Botanical Gardens. Oversized type, a terracotta sun, olive geometric shapes, and cream paper', style: 'bauhaus' },
  carousel: { title: 'A good story\nkeeps them swiping.', description: 'Build a sequence with a strong opening, a clear rhythm, and something worth saving on the last slide.', detail: 'Three-slide social story', brief: 'a five-slide Instagram carousel about building a calmer morning: a cover, three practical tips, and a save-and-share closing slide; sage, cream, and editorial typography', style: 'editorial' },
  canvas: { title: 'Your idea.\nRoom to play.', description: 'Create a graphic you can keep shaping. Move the pieces, refine the type, and make every detail yours.', detail: 'Editable graphic · layout study', brief: 'an editable square social graphic for a spring collection launch, with a cream background, lavender geometric forms, large dark typography, and a small date label', style: 'minimal' },
  shopping: { title: 'Find the pieces\nthat belong together.', description: 'Describe your space, your taste, and your budget for a collection that feels considered.', detail: 'Sample room collection · illustrative prices', brief: 'a calm mid-century reading corner under $1200: an accent chair, a floor lamp, and a side table in warm wood, cream, and sage; include current product links and a budget breakdown' },
  document: { title: 'Good thinking.\nBeautifully presented.', description: 'Turn a rough idea into a document with structure, clear writing, and a thoughtful page layout.', detail: 'Business plan · document sample', brief: 'a concise business plan for Sunday, a neighborhood coffee shop, with an executive summary, concept, customer profile, launch plan, and clearly labeled financial assumptions' },
  presentation: { title: 'Make your\nnext big point.', description: 'Build a story that moves naturally from one slide to the next, with space for your ideas to land.', detail: 'Pitch deck · three-slide sample', brief: 'a six-slide pitch for Forma, a collaborative workspace app: the problem, solution, product, market, business model, and next steps; clearly label any illustrative metrics', style: 'minimal' },
  spreadsheet: { title: 'Bring a little\nclarity to the numbers.', description: 'Organize a budget, track a project, or model an idea with a workbook that is easy to read and use.', detail: 'Monthly budget · sample figures', brief: 'a monthly household budget workbook with income, housing, food, transport, planned versus actual spending, formula-driven differences, totals, and a summary chart' },
  image: { title: 'Picture something\nonly you can imagine.', description: 'Describe the subject, setting, light, and mood. Shape an image around the picture in your head.', detail: 'Coastal landscape · painterly study', brief: 'a luminous painterly coastal landscape, turquoise water washing over a sandy beach, dramatic soft clouds, distant rocks, warm afternoon light, and delicate oil-paint texture' },
  video: { title: 'Set the scene.\nTell it in motion.', description: 'Describe the opening shot, the mood, and how the camera should move. Give your story a cinematic beginning.', detail: 'Animated shot study · coastal opening', brief: 'a cinematic coastal establishing shot: a slow camera push toward turquoise surf and distant rocks, soft afternoon clouds, warm sunlight, and a peaceful mood' },
}

function AsterMark() {
  return <svg viewBox="0 0 100 100" fill="none"><path d="M50 85V36M50 62C18 64 17 34 20 21c21 2 34 18 30 41ZM50 49C49 27 67 13 82 13c0 21-11 36-32 36Z" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function FloorPlan() {
  return <svg viewBox="0 0 460 340" className="studio-sample-plan">
    <g fill="none" stroke="currentColor" strokeWidth="1" opacity=".25"><path d="M55 35H405M55 27V43M405 27V43M29 60V295M21 60H37M21 295H37" /></g>
    <g fill="currentColor" fontSize="10" textAnchor="middle"><text x="230" y="25">10.0 m</text><text x="17" y="180" transform="rotate(-90 17 180)">6.7 m</text></g>
    <path d="M55 295V60H405V295H250M215 295H55 M55 168H200M238 168H405M218 60V142M218 168V198M320 168V222M320 254V295" fill="#f0f1e8" stroke="currentColor" strokeWidth="5" />
    <g fill="none" stroke="currentColor" opacity=".55"><path d="M215 295V260a35 35 0 0 1 35 35M320 254h-32a32 32 0 0 1 32-32M200 168v-38a38 38 0 0 1 38 38" /></g>
    <g fill="#d3ddcc" stroke="currentColor" strokeWidth="1"><rect x="77" y="80" width="68" height="60" rx="3" /><rect x="81" y="84" width="27" height="14" rx="2" /><rect x="112" y="84" width="27" height="14" rx="2" /><rect x="298" y="80" width="67" height="60" rx="3" /><rect x="302" y="84" width="26" height="14" rx="2" /><rect x="331" y="84" width="27" height="14" rx="2" /><rect x="73" y="190" width="95" height="29" rx="5" /><rect x="78" y="222" width="25" height="32" rx="4" /><rect x="124" y="234" width="45" height="29" rx="9" /><rect x="254" y="184" width="45" height="60" rx="20" /><rect x="339" y="185" width="48" height="21" rx="5" /></g>
    <g fill="currentColor" fontSize="9" textAnchor="middle"><text x="173" y="118">BED 01</text><text x="257" y="118">BED 02</text><text x="159" y="283">LIVING</text><text x="276" y="266">DINING</text><text x="361" y="243">BATH</text><text x="230" y="325" letterSpacing="3">THE GARDEN RETREAT</text></g>
  </svg>
}

function Room() {
  return <svg viewBox="0 0 460 340" className="studio-sample-room">
    <path d="M32 128 225 42 427 131 232 225Z" fill="#f7f0e4" /><path d="M32 128 232 225V312L32 215Z" fill="#d5b892" /><path d="M232 225 427 131V218L232 312Z" fill="#b19372" />
    <path d="M32 128V42L232 133V225Z" fill="#e8ddc9" /><path d="M232 133 427 42V131L232 225Z" fill="#f6eedf" />
    <path d="m278 126 103-48v63l-103 49Z" fill="#accbd0" /><path d="m289 137 79-37v32l-79 38Z" fill="#d9e7de" /><path d="M330 103v63" stroke="#f6eedf" strokeWidth="5" />
    <path d="m83 155 122 54 43-20-121-56Z" fill="#a4b29b" /><path d="m83 155 122 54v33L83 188Z" fill="#657f70" /><path d="m205 209 43-20v33l-43 20Z" fill="#526e60" /><path d="m91 146 113 51 1-28-112-51Z" fill="#879e87" />
    <ellipse cx="278" cy="234" rx="47" ry="21" fill="#decbae" /><path d="M253 238v28M303 238v23" stroke="#876b50" strokeWidth="5" /><ellipse cx="278" cy="230" rx="47" ry="21" fill="#c29b70" /><ellipse cx="278" cy="230" rx="19" ry="8" fill="#eee4d3" />
    <path d="m373 190 7 28h17l7-28" fill="#c09a74" /><ellipse cx="388" cy="190" rx="16" ry="7" fill="#8d7860" /><path d="M388 190v-49" stroke="#527762" strokeWidth="3" /><g fill="#678c72"><ellipse cx="376" cy="150" rx="9" ry="18" transform="rotate(-40 376 150)" /><ellipse cx="399" cy="139" rx="8" ry="18" transform="rotate(35 399 139)" /><ellipse cx="399" cy="163" rx="8" ry="15" transform="rotate(45 399 163)" /></g>
  </svg>
}

function GameScene() {
  return <svg viewBox="0 0 460 340" className="studio-sample-game">
    <rect width="460" height="340" fill="#dce9f0" /><circle cx="358" cy="77" r="36" fill="#f7db9b" /><g fill="#f8fbfc"><rect x="34" y="56" width="105" height="20" rx="10" /><rect x="65" y="42" width="47" height="24" rx="12" /><rect x="233" y="110" width="75" height="15" rx="8" /></g>
    <path d="m0 270 89-91 93 91 64-78 130 85 84-66v129H0Z" fill="#c1d4d9" />
    {[[56,220,124],[222,164,83],[348,232,87]].map(([x,y,w]) => <g key={x}><path d={`M${x} ${y}h${w}l-18 52h-${w-36}Z`} fill="#a38774" /><rect x={x} y={y-8} width={w} height="15" rx="6" fill="#7ca88b" /><path d={`m${x+w/2} ${y-45} 7 10-7 10-7-10Z`} fill="#dcaa4f" /></g>)}
    <g transform="translate(104 174)"><rect x="-8" y="17" width="23" height="24" rx="5" fill="#5c7894" /><circle cx="3" cy="7" r="13" fill="#c99173" /><path d="M-12 7q0-23 26-8v8" fill="#4d5c68" /><path d="M-3 40v7M11 40v7" stroke="#34485b" strokeWidth="6" /></g>
    <text x="26" y="29" fill="#355465" fontSize="10" letterSpacing="2">LITTLE ISLANDS</text><text x="433" y="29" textAnchor="end" fill="#355465" fontSize="10">◆ 03</text>
  </svg>
}

function Product({ kind }: { kind: 'chair' | 'lamp' | 'table' }) {
  return <svg viewBox="0 0 120 120">
    {kind === 'chair' ? <g><path d="m25 77-7 30m74-30 8 30" stroke="#907558" strokeWidth="5" /><rect x="26" y="18" width="67" height="62" rx="21" fill="#96a38b" /><rect x="21" y="62" width="76" height="27" rx="11" fill="#7c8f74" /><path d="M18 51v36M101 51v36" stroke="#ad8f6f" strokeWidth="7" strokeLinecap="round" /></g> : kind === 'lamp' ? <g><path d="M62 42v62" stroke="#9b8361" strokeWidth="4" /><ellipse cx="62" cy="106" rx="22" ry="5" fill="#9b8361" /><path d="M39 18h45l16 34H23Z" fill="#d6c6a4" /><ellipse cx="61" cy="52" rx="38" ry="7" fill="#c4b28e" /></g> : <g><path d="M27 57v43M93 57v43M61 63v46" stroke="#916c4b" strokeWidth="6" /><ellipse cx="60" cy="54" rx="45" ry="20" fill="#b98e65" /><ellipse cx="60" cy="49" rx="45" ry="20" fill="#d2aa7d" /></g>}
  </svg>
}

function Sample({ kind }: { kind: string }) {
  switch (kind) {
    case 'logo': return <div className="studio-sample-logo"><div className="studio-sample-logo-main"><AsterMark /><strong>aster</strong><span>BOTANICAL CARE</span></div><div className="studio-sample-logo-footer"><span><AsterMark />aster</span><span>Thoughtfully rooted.</span></div></div>
    case 'palette': return <div className="studio-sample-palette"><div className="studio-sample-swatches">{[['Pine','#294B40'],['Sage','#A3B49B'],['Cream','#F3EEE3'],['Sand','#D4B995'],['Clay','#B7755D']].map(([name,color]) => <div key={name}><i style={{ background: color }} /><strong>{name}</strong><span>{color}</span></div>)}</div><div className="studio-sample-color-card"><span>THE COASTAL COLLECTION</span><h4>A softer kind<br />of everyday.</h4><p>Room to breathe. Colors to come home to.</p><span className="studio-sample-color-chip">Find your balance ↗</span></div></div>
    case 'brand': return <div className="studio-sample-brand"><div className="studio-sample-book-cover"><span>BRAND GUIDELINES / 01</span><AsterMark /><h4>aster</h4><span>A naturally different perspective.</span></div><div className="studio-sample-book-page"><span>THE VISUAL LANGUAGE</span><h4>Rooted<br />in simplicity.</h4><div className="studio-sample-brand-colors"><i /><i /><i /></div><strong>Aa Bb Cc</strong><p>Considered typography.<br />Warm, honest words.</p><span>IDENTITY — 02</span></div></div>
    case 'blueprint': return <FloorPlan />
    case 'walkthrough': return <Room />
    case 'motion': return <div className="studio-sample-motion"><span>A BOTANICAL BEGINNING</span><div className="studio-sample-motion-mark"><AsterMark /></div><h4>aster</h4><p>Let good things grow.</p><div className="studio-sample-timeline"><i /></div></div>
    case 'game': return <GameScene />
    case 'poster': return <div className="studio-sample-poster"><span>BOTANICAL GARDENS PRESENTS</span><h4>solstice<br /><em>sessions.</em></h4><div className="studio-sample-poster-art"><i /><b /><span /></div><footer><strong>JUN 21</strong><span>JAZZ IN THE GARDEN<br />FROM GOLDEN HOUR ON</span></footer></div>
    case 'carousel': return <div className="studio-sample-carousel"><div><span>THE SLOWER SERIES / 01</span><h4>A calmer<br />kind of<br /><em>morning.</em></h4><i /><small>Three small shifts →</small></div><div><span>01 / MAKE SPACE</span><h4>Start with<br />a little<br />stillness.</h4><p>Before the scroll,<br />take a breath.</p><small>Swipe to keep going →</small></div><div><span>02 / LET LIGHT IN</span><i /><h4>Find your<br />first light.</h4><small>A moment for you.</small></div></div>
    case 'canvas': return <div className="studio-sample-canvas"><div className="studio-sample-canvas-tools">↖<span>□</span><span>○</span><span>T</span><span>✎</span></div><div className="studio-sample-artboard"><span>STUDIO / SPRING 01</span><i /><div className="studio-sample-selection"><h4>Fresh<br /><em>perspective.</em></h4><b /><b /><b /><b /></div><p>A new season. A new point of view.</p></div><span className="studio-sample-canvas-scale">1080 × 1080</span></div>
    case 'shopping': return <div className="studio-sample-shopping"><span>THE CONSIDERED CORNER</span><h4>Your new favorite spot.</h4><div>{([['chair','Lounge chair','$480'],['lamp','Linen floor lamp','$160'],['table','Oak side table','$220']] as const).map(([kind,name,price]) => <article key={kind}><div><Product kind={kind} /></div><strong>{name}</strong><span>{price}</span></article>)}</div><footer><span>3 pieces · sample collection</span><strong>$860</strong></footer></div>
    case 'document': return <div className="studio-sample-document"><div className="studio-sample-document-page"><header>SUNDAY COFFEE <span>BUSINESS PLAN / 01</span></header><h4>A neighborhood<br />ritual, reimagined.</h4><p className="studio-sample-document-intro">Good coffee. A familiar face.<br />A reason to stay a little longer.</p><hr /><div><section><strong>01 / THE CONCEPT</strong><p>A welcoming corner café built around carefully sourced coffee and everyday connection.</p></section><section><strong>02 / THE EXPERIENCE</strong><p>Seasonal drinks, a small fresh menu, and a warm space for the neighborhood to gather.</p></section></div><blockquote>Make the everyday<br />feel a little more special.</blockquote><footer>CONFIDENTIAL · SAMPLE PLAN <span>01</span></footer></div></div>
    case 'presentation': return <div className="studio-sample-deck"><div className="studio-sample-slide"><span>FORMA / THE NEXT CHAPTER</span><h4>Great work<br />starts <em>together.</em></h4><p>A clearer space for teams to think, plan, and build.</p><div className="studio-sample-slide-art"><i /><i /><i /></div><footer>THE PRODUCT STORY <span>01 / 06</span></footer></div><div className="studio-sample-slide-strip"><div><span>01</span><strong>The vision.</strong></div><div><span>02</span><strong>Less friction.</strong></div><div><span>03</span><strong>More possibility.</strong></div></div></div>
    case 'spreadsheet': return <div className="studio-sample-sheet"><header><span>HOUSEHOLD / MONTHLY PLAN</span><h4>A little more in balance.</h4></header><div className="studio-sample-formula"><span>C7</span><span>ƒx</span><code>=SUM(C3:C6)</code></div><table><thead><tr>{['','Category','Planned','Actual','Left'].map((v,i) => <th key={i}>{v}</th>)}</tr></thead><tbody>{[['1','Income','$5,200','$5,200','—'],['2','Expenses','','',''],['3','Housing','$1,800','$1,800','$0'],['4','Food','$600','$540','$60'],['5','Transport','$300','$260','$40'],['6','Other','$400','$350','$50'],['7','Total','$3,100','$2,950','$150']].map(row => <tr key={row[0]}>{row.map((v,i) => <td key={i}>{v}</td>)}</tr>)}</tbody></table><footer><span>Budget</span><span>Summary</span><span>↗ $150 under plan</span></footer></div>
    case 'image': return <div className="studio-sample-image"><img src="/images/bg-beach-rocks.png" alt="" /><div><span>STUDIES IN LIGHT / 01</span><h4>Where the<br />day slows down.</h4></div><span className="studio-sample-image-caption">Coastal light · painterly texture</span></div>
    case 'video': return <div className="studio-sample-video"><div className="studio-sample-video-shot"><img src="/images/bg-beach-rocks.png" alt="" /><span>THE COAST, IN SLOW MOTION</span><h4>Stay a little longer.</h4></div><div className="studio-sample-filmstrip">{[0,1,2,3].map(i => <div key={i} style={{ backgroundPosition: `${i*33}% center` }} />)}</div><div className="studio-sample-timeline"><i /></div></div>
    default: return null
  }
}

export default function StudioStarter({ tool, hasBrief, onStart, onWrite }: {
  tool: Tool; hasBrief: boolean; onStart: (brief: string, style: string) => void; onWrite: () => void
}) {
  const example = EXAMPLES[tool.key]
  // Animated examples start still, including for people who prefer reduced motion.
  const [playing, setPlaying] = useState(false)
  if (!example) return null
  const animated = tool.key === 'motion' || tool.key === 'video'
  return <section className="website-starter studio-starter" aria-label={`${tool.name} starting point`}>
    <div className="website-starter-copy">
      <span className="website-starter-eyebrow"><tool.icon size={15} />A little inspiration</span>
      <h3>{example.title}</h3>
      <p>{example.description}</p>
      <div className="studio-starter-detail"><Sparkles size={13} /><span>{example.detail}</span></div>
      <button className="website-starter-primary" onClick={() => onStart(example.brief, example.style || 'none')}>{hasBrief ? 'Continue your brief' : 'Use this starting point'}<ArrowRight size={17} /></button>
      {!hasBrief && <button className="website-starter-own" onClick={onWrite}>Or write your own brief<ArrowUpRight size={14} /></button>}
    </div>
    <div className="website-starter-showcase">
      <div className="website-starter-sample-label"><span>Inspiration preview</span><span>{tool.name}</span></div>
      <div className={`studio-sample studio-sample-${tool.key}-frame${playing ? ' is-playing' : ''}`} aria-hidden="true"><Sample kind={tool.key} /></div>
      {animated && <button className="studio-starter-play" aria-pressed={playing} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? 'Pause example' : 'Play example'}</button>}
      <p className="website-starter-note">An example to spark your idea. Your creation will take this space.</p>
    </div>
  </section>
}
