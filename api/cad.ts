// Nalu CAD — Vercel Node serverless function.
// Generates production-grade OpenSCAD from a description (or repairs failing
// code), which the client compiles to STL in-browser and renders in 3D.
//   POST { prompt }                 -> { code }   (new model)
//   POST { code, error, prompt? }   -> { code }   (self-repair a compile failure)

import { chatCompleteContinued } from './_llm'
import { reserveStudioQuota, studioLimitMessage } from './_limits'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_KEY = env('TINKER_API_KEY') || ''
const LLM_MODEL = env('NALU_CAD_MODEL') || 'thinkingmachines/Inkling'

const SYSTEM = `You are a world-class mechanical and industrial product designer who writes expert, production-grade OpenSCAD. Given a description, output ONE compilable OpenSCAD program that models the object in realistic, detailed, professional quality — like a finished engineered product, never a bare primitive.

Output ONLY raw OpenSCAD code — no markdown, no prose, no comments-as-explanation.

Quality bar (apply all that fit the object):
- PARAMETRIC: declare every key dimension as a named variable at the top, with realistic millimetre values and correct, believable proportions.
- STRUCTURE with modules: one module per part or feature, then compose them into a final assembly. For multi-part objects, model each part and position/orient them correctly so they fit together.
- SUPER-DETAILED — this is the bar that matters. Model the SMALL features that make an object read as real: rounded edges & fillets, chamfers, correct wall thickness, ribs/gussets, holes/bosses/countersinks, screw heads/seats, seams and parting lines, vents/grilles/slots, buttons/knobs/handles, grips/knurling (as shallow v-grooves or bump arrays), feet/pads, logos as simple embossed shapes, and accurate functional geometry. A model with 8-20 composed modules and dozens of features beats a clean but plain shell. Never ship a bare primitive with a hole in it.
- ROUNDING — IMPORTANT: NEVER use minkowski() on 3D solids (it is the #1 cause of CGAL render timeouts and empty output). For rounded boxes use hull() of small corner spheres/cylinders; for rounded 2D profiles use offset(r=) on a polygon/square then linear_extrude/rotate_extrude. Keep boolean trees shallow.
- REPETITION IS CHEAP DETAIL: use for() loops for fastener patterns, fins, treads, spokes, grille bars, and knurling — high perceived detail at low render cost.
- RESOLUTION — keep facet counts sane so it renders fast: set \`$fn = 64;\` (up to 96 only for small visible round features) AND \`$fa = 4; $fs = 0.4;\` near the top. Do NOT use \`$fn\` above 96 anywhere, and avoid huge high-$fn spheres.
- VALID & MANIFOLD: a single printable solid (union the assembly), balanced brackets, valid syntax, no external files/fonts/imports, no import()/surface()/use<>. text() IS allowed for small engraved/embossed labels (default font). It MUST compile and render in OpenSCAD within ~20 seconds.
- Make it genuinely impressive and true to a real, well-designed part.
- DIMENSIONALLY EXACT — model REAL sizes, not vibes. Hardware: bolts get correct proportions (hex head across-flats ≈ 1.5× nominal Ø, head height ≈ 0.65× Ø, thread rendered as a shallow v-groove ring pattern; standard sizes M6/M8/M10/M12 or 1/4"/3/8"/1/2"), nuts match the bolt, washers OD ≈ 2× Ø, anchor bolts show hook + embed depth. Construction: nominal lumber at ACTUAL size (2x4 = 38×89 mm, 2x6 = 38×140 mm), studs at 406 mm (16" OC) with top+bottom plates and headers over openings; slabs 100–150 mm thick with turned-down edges/footings (300–600 mm); CMU 194×194×397 mm; doors 813–914 × 2032 mm; windows with 900 mm sills; stairs ≈ 178 mm rise / 254 mm run; floor-to-floor 2700–3000 mm; roof pitch 4:12–8:12. Whole buildings must be SCALE-COHERENT: wall thickness, openings, and roof all consistent with the declared footprint — a 1800 mm person would look right beside it.
- Declare the real dimensions as the parametric variables (bolt_d = 12; stud_spacing = 406; slab_t = 125;) so the model is verifiably exact from a single bolt up to a whole building.

Reference techniques (use as appropriate, do not copy literally):
module rounded_box(s, r) { hull() { for (x=[-1,1], y=[-1,1], z=[-1,1]) translate([x*(s[0]/2-r), y*(s[1]/2-r), z*(s[2]/2-r)]) sphere(r=r); } }
module rounded_plate(w, d, h, r) { linear_extrude(h) offset(r=r) square([w-2*r, d-2*r], center=true); }`

const FIX_SYSTEM = `You are an OpenSCAD expert. The following OpenSCAD code failed to compile/render (empty or invalid output). Diagnose and FIX every problem so it produces a valid, manifold solid. Keep the design intent and detail. Output ONLY the corrected, complete, compilable OpenSCAD code — no markdown, no prose.`

const EDIT_SYSTEM = `You are editing an existing OpenSCAD model. You are given the CURRENT model and a requested change.
- If the request modifies the current model (resize, add/remove a feature, adjust proportions, etc.), apply it while preserving the rest of the design, detail, and parametric structure.
- If the request is a COMPLETELY DIFFERENT object, design that new object fresh at the same professional, detailed, parametric quality.
Output ONLY the complete, updated, compilable OpenSCAD code — no markdown, no prose. Keep \`$fn\` high and the model manifold.`

function cleanScad(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const fence = t.match(/```(?:openscad|scad|c)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  return t
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// Pull real reference specs/dimensions from the web (Wikipedia) so the model
// designs to accurate, standard measurements instead of guessing.
async function reference(prompt: string): Promise<string> {
  try {
    const s = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        prompt + ' dimensions specification standard',
      )}&format=json&srlimit=2`,
      { headers: { 'User-Agent': UA } },
    )
    const sd = (await s.json()) as { query?: { search?: Array<{ title?: string }> } }
    const title = sd.query?.search?.[0]?.title
    if (!title) return ''
    const e = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(
        title,
      )}&format=json`,
      { headers: { 'User-Agent': UA } },
    )
    const ed = (await e.json()) as { query?: { pages?: Record<string, { extract?: string }> } }
    const page = Object.values(ed.query?.pages || {})[0]
    return (page?.extract || '').slice(0, 1200)
  } catch {
    return ''
  }
}

async function llm(messages: Array<{ role: string; content: string }>): Promise<string> {
  // Robust: timeout + provider failover + a continuation pass if the model hits
  // the token ceiling (super-detailed assemblies are long) — so complex models
  // arrive complete instead of truncated mid-module.
  const r = await chatCompleteContinued(messages, { model: LLM_MODEL, maxTokens: 13000, timeoutMs: 100000, retryPrimary: false, temperature: 0.15 })
  return cleanScad(r.content)
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
  const badCode = typeof body.code === 'string' ? body.code : ''
  const error = typeof body.error === 'string' ? body.error : ''
  const prevCode = typeof body.prevCode === 'string' ? body.prevCode : ''

  // Meter fresh generations/edits, but NOT automatic self-repair (it's a retry of
  // work the user already paid a slot for).
  const isRepair = !!(badCode && error)
  const quota = isRepair ? null : await reserveStudioQuota(req, 'cad')
  if (quota && !quota.ok) {
    res.status(429).json({ error: studioLimitMessage('3D model', quota) })
    return
  }
  let succeeded = false
  try {
    let code: string
    if (badCode && error) {
      // Self-repair mode.
      code = await llm([
        { role: 'system', content: FIX_SYSTEM },
        {
          role: 'user',
          content: `${prompt ? `Intended object: ${prompt}\n\n` : ''}Code:\n${badCode}\n\nCompile error / problem:\n${error.slice(0, 1500)}`,
        },
      ])
    } else if (prevCode && prompt) {
      // Iterate mode — edit the current model (keep the screen, new mockup).
      code = await llm([
        { role: 'system', content: EDIT_SYSTEM },
        { role: 'user', content: `Current model:\n${prevCode}\n\nRequested change: ${prompt}` },
      ])
    } else {
      if (!prompt) {
        res.status(400).json({ error: 'prompt required' })
        return
      }
      const ref = await reference(prompt)
      code = await llm([
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: ref
            ? `Reference data (use these real, accurate dimensions/standards/proportions where relevant):\n${ref}\n\nNow design this in OpenSCAD: ${prompt}`
            : prompt,
        },
      ])
    }
    if (!code || code.length < 10) {
      res.status(502).json({ error: 'Could not generate the model. Try rephrasing.' })
      return
    }
    res.status(200).json({ code, name: 'Nalu CAD' })
    succeeded = true
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'cad error' })
  } finally {
    if (quota && !succeeded) await quota.release()
  }
}
