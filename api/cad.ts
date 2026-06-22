// Nalu CAD — Vercel Node serverless function.
// Generates production-grade OpenSCAD from a description (or repairs failing
// code), which the client compiles to STL in-browser and renders in 3D.
//   POST { prompt }                 -> { code }   (new model)
//   POST { code, error, prompt? }   -> { code }   (self-repair a compile failure)

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_BASE = (
  env('GLM_BASE_URL') || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
).replace(/\/+$/, '')
const LLM_KEY = env('GLM_API_KEY') || ''
const LLM_MODEL = env('NALU_CAD_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

const SYSTEM = `You are a world-class mechanical and industrial product designer who writes expert, production-grade OpenSCAD. Given a description, output ONE compilable OpenSCAD program that models the object in realistic, detailed, professional quality — like a finished engineered product, never a bare primitive.

Output ONLY raw OpenSCAD code — no markdown, no prose, no comments-as-explanation.

Quality bar (apply all that fit the object):
- PARAMETRIC: declare every key dimension as a named variable at the top, with realistic millimetre values and correct, believable proportions.
- STRUCTURE with modules: one module per part or feature, then compose them into a final assembly. For multi-part objects, model each part and position/orient them correctly so they fit together.
- REAL DETAIL: rounded edges & fillets (use minkowski() with a small sphere/cylinder, hull() of primitives, or offset() for 2D profiles), chamfers, correct wall thickness, ribs/gussets, holes/bosses/countersinks, screw seats, grips/knurling, and accurate functional geometry — not plain cubes/cylinders.
- SMOOTH: set \`$fn = 96;\` near the top (higher for small round features).
- VALID & MANIFOLD: a single printable solid, balanced brackets, valid syntax, no external files/fonts/imports. It MUST compile in OpenSCAD.
- Make it genuinely impressive and true to a real, well-designed part.

Reference techniques (use as appropriate, do not copy literally):
module rounded_box(s, r) { minkowski() { cube([s[0]-2*r, s[1]-2*r, s[2]-2*r], center=true); sphere(r=r); } }
module fillet_cyl(h, d, r) { minkowski() { cylinder(h=h-2*r, d=d-2*r, center=true); sphere(r=r); } }`

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
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, stream: false, max_tokens: 6000, messages }),
  })
  if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
  const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return cleanScad(d?.choices?.[0]?.message?.content || '')
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
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'cad error' })
  }
}
