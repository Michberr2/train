import type { ToolSpec } from '../agentApi'
export type UiValue = string | boolean
export type UiValues = Record<string, UiValue>
export interface UiBlock {
  id: string; type: 'text' | 'metrics' | 'table' | 'chart' | 'checklist' | 'form' | 'calculator' | 'actions' | 'map' | 'agents' | 'workflow' | 'connections'
  title: string; query?: string; width: 'full' | 'half' | 'third'; text?: string
  items?: { id: string; label: string; value: string; detail: string; checked: boolean }[]
  columns?: string[]; rows?: string[][]
  fields?: { id: string; label: string; type: 'text' | 'number' | 'textarea'; value: string }[]
  calculations?: { label: string; formula: string; format: 'number' | 'currency' | 'percent' }[]
  actions?: { label: string; prompt: string }[]
  sources?: { label: string; url: string }[]
}
export interface GenerativeUi { version: 1; title: string; description: string; blocks: UiBlock[] }
const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 4000) => typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
const list = (v: unknown, max: number) => Array.isArray(v) ? v.slice(0, max) : []
const identifier = (v: unknown, fallback: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(String(v)) ? String(v) : fallback
export function parseGenerativeUi(value: unknown): GenerativeUi | null {
  if (!rec(value) || !Array.isArray(value.blocks)) return null
  const ids = new Set<string>()
  const blocks: UiBlock[] = []
  for (const [index, raw] of value.blocks.slice(0, 24).entries()) {
    if (!rec(raw) || !['text','metrics','table','chart','checklist','form','calculator','actions','map','agents','workflow','connections'].includes(String(raw.type))) continue
    const id = identifier(raw.id, `block-${index}`)
    if (ids.has(id)) continue
    ids.add(id)
    blocks.push({ id, type: raw.type as UiBlock['type'], title: str(raw.title, 160), width: ['half','third'].includes(String(raw.width)) ? raw.width as UiBlock['width'] : 'full',
      text: str(raw.text, 20000), query: str(raw.query, 500),
      items: list(raw.items, 50).filter(rec).map((x, i) => ({ id: identifier(x.id, `item-${i}`), label: str(x.label, 300), value: str(x.value, 500), detail: str(x.detail, 800), checked: x.checked === true })),
      columns: list(raw.columns, 16).map(x => str(x, 160)), rows: list(raw.rows, 100).map(row => list(row, 16).map(x => str(x, 2000))),
      fields: list(raw.fields, 20).filter(rec).map((x, i) => ({ id: identifier(x.id, `field-${i}`), label: str(x.label, 160), type: ['number','textarea'].includes(String(x.type)) ? x.type as 'number' | 'textarea' : 'text', value: str(x.value, 4000) })),
      calculations: list(raw.calculations, 12).filter(rec).map(x => ({ label: str(x.label, 160), formula: str(x.formula, 200), format: ['currency','percent'].includes(String(x.format)) ? x.format as 'currency' | 'percent' : 'number' })),
      actions: list(raw.actions, 8).filter(rec).map(x => ({ label: str(x.label, 120), prompt: str(x.prompt, 2000) })).filter(x => x.label && x.prompt),
      sources: list(raw.sources, 20).filter(rec).map(x => ({ label: str(x.label, 200), url: str(x.url, 2000) })).filter(x => { try { return ['https:', 'http:'].includes(new URL(x.url).protocol) } catch { return false } }),
    })
  }
  return { version: 1, title: str(value.title, 180) || 'Your workspace', description: str(value.description, 1600), blocks }
}
/** Only fully received block objects are revealed. Partial strings/JSON never execute. */
export function readStreamingUi(argumentsText: string): GenerativeUi | null {
  try { return parseGenerativeUi(JSON.parse(argumentsText)) } catch { /* recover complete blocks */ }
  const start = /"blocks"\s*:\s*\[/.exec(argumentsText)
  if (!start) return null
  const blocks: unknown[] = []
  let depth = 0, quoted = false, escape = false, objectStart = -1
  for (let i = start.index + start[0].length; i < argumentsText.length; i++) {
    const c = argumentsText[i]
    if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; continue }
    if (c === '"') { quoted = true; continue }
    if (c === '{') { if (depth === 0) objectStart = i; depth++ }
    if (c === '}') { depth--; if (depth === 0 && objectStart >= 0) { try { blocks.push(JSON.parse(argumentsText.slice(objectStart, i + 1))) } catch { /* omit malformed block */ }; objectStart = -1 } }
    if (c === ']' && depth === 0) break
  }
  const titleMatch = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(argumentsText.slice(0, start.index))
  let title = 'Taking shape'
  try { if (titleMatch) title = JSON.parse(titleMatch[1]) } catch { /* neutral title */ }
  return blocks.length ? parseGenerativeUi({ title, blocks }) : null
}
/** Small arithmetic grammar, never eval/Function. Missing inputs and zero denominators stay unknown. */
export function calculate(formula: string, fields: Record<string, string>): number | null {
  if (formula.length > 200) return null
  const tokens = formula.match(/(?:\d+(?:\.\d*)?|\.\d+)|[a-zA-Z][a-zA-Z0-9_]*|[()+*/-]/g) || []
  if (tokens.join('').replace(/\s/g, '') !== formula.replace(/\s/g, '')) return null
  let at = 0
  const atom = (): number => {
    const token = tokens[at++]
    if (token === '-') return -atom()
    if (token === '+') return atom()
    if (token === '(') { const value = expression(); if (tokens[at++] !== ')') throw new Error('parenthesis'); return value }
    if (!token) throw new Error('incomplete')
    const raw = /^[a-zA-Z]/.test(token) ? fields[token] : token
    if (raw == null || raw.trim() === '' || !Number.isFinite(Number(raw))) throw new Error('unknown input')
    return Number(raw)
  }
  const product = (): number => { let value = atom(); while (tokens[at] === '*' || tokens[at] === '/') { const op = tokens[at++], right = atom(); if (op === '/' && right === 0) throw new Error('zero denominator'); value = op === '*' ? value * right : value / right } return value }
  const expression = (): number => { let value = product(); while (tokens[at] === '+' || tokens[at] === '-') { const op = tokens[at++], right = product(); value = op === '+' ? value + right : value - right } return value }
  try { const value = expression(); return at === tokens.length && Number.isFinite(value) ? value : null } catch { return null }
}
const string = { type: 'string' }
const objects = (properties: Record<string, unknown>, required: string[]) => ({ type: 'array', items: { type: 'object', properties, required } })
export const GENERATIVE_UI_TOOL: ToolSpec = { type: 'function', function: {
  name: 'present_workspace',
  description: 'Build the user’s live interactive workspace. Use for substantive answers: arrange useful text, comparisons, charts, editable calculations, checklists and forms around the actual question. Use real supplied/researched data only; label assumptions and missing inputs. Do research with existing tools first when needed. Fields and checkboxes are editable and saved. Use stable block and field IDs across revisions. calculator field IDs must use letters, digits and underscores; formula uses field IDs, numbers, + - * / and parentheses only; percent format expects a fractional value (0.05 = 5%). Actions contain follow-up prompts and cannot claim to run other skills; actual execution uses existing tools. Do not put executable HTML or code in this tool. Cite actual sources using sources. Prefer concise useful blocks to duplicating the whole answer as prose.',
  parameters: { type: 'object', properties: { title: string, description: string, blocks: objects({
    id: string, type: { type: 'string', enum: ['text','metrics','table','chart','checklist','form','calculator','actions','map','agents','workflow','connections'] }, title: string, width: { type: 'string', enum: ['full','half','third'] }, text: string, query: string,
    items: objects({ id: string, label: string, value: string, detail: string, checked: { type: 'boolean' } }, ['label']),
    columns: { type: 'array', items: string }, rows: { type: 'array', items: { type: 'array', items: string } },
    fields: objects({ id: string, label: string, type: { type: 'string', enum: ['text','number','textarea'] }, value: string }, ['id','label','type']),
    calculations: objects({ label: string, formula: string, format: { type: 'string', enum: ['number','currency','percent'] } }, ['label','formula','format']),
    actions: objects({ label: string, prompt: string }, ['label','prompt']), sources: objects({ label: string, url: string }, ['label','url']),
  }, ['id','type','title','width']) }, required: ['title','blocks'] },
} }
export const GENERATIVE_UI_INSTRUCTION = 'This is the generative Nalu workspace. Respond to the question by composing a useful interface in the supported layout format, even when a single text block is best. Keep all existing tools and skills available. Use actual research/tool results, not invented facts. The interface renders as each complete block arrives. Use a map block with a query to open the real interactive map; an agents block to coordinate actual project agents and private/group conversations; a workflow block for the real automation builder; a connections block to manage actual connected accounts. These are live tools, not screenshots or links to old sections. Acknowledge the result briefly after the layout; do not repeat all its content. When changing a prior workspace, preserve its stable IDs, user inputs and completed checklist items unless the user requests changing them. A form submits its user-entered values as the next message; write its action prompt to continue the actual task. Calculator fields remain editable and calculate locally. Never state an action, download, saved file or external operation happened just because an action button is displayed.'
export function uiFromText(text: string): { ui: GenerativeUi | null; complete: boolean } {
  const match = /```(?:nalu_ui|json)\s*\n/.exec(text)
  const rawStart = !match && text.trimStart().startsWith('{')
  if (!match && !rawStart) return { ui: null, complete: false }
  const body = match ? text.slice(match.index + match[0].length) : text.trimStart()
  const end = match ? body.indexOf('```') : -1
  const raw = end >= 0 ? body.slice(0, end) : body
  try { const ui = parseGenerativeUi(JSON.parse(raw)); return { ui, complete: !!ui } } catch { /* streaming prefix */ }
  return { ui: readStreamingUi(raw), complete: false }
}
export function workspaceText(text: string): string {
  const ui = uiFromText(text).ui
  if (ui && text.trimStart().startsWith('{')) return ''
  return text.replace(ui ? /```(?:nalu_ui|json)\s*\n[\s\S]*?(?:```|$)/g : /```nalu_ui\s*\n[\s\S]*?(?:```|$)/g, '').trim()
}
export const STREAMING_UI_INSTRUCTION = `${GENERATIVE_UI_INSTRUCTION}\nFor progressive rendering, output the layout as a fenced nalu_ui JSON block, not a function call. Start with title, description, then blocks. The complete blocks render as their bytes arrive. This is a declarative display format; it never executes code or tools. Use the supplied real tools normally before composing the UI. The layout JSON must follow this schema: ${JSON.stringify(GENERATIVE_UI_TOOL.function.parameters)}. Do not output speculative data while research is running. A simple question can use a single text block. For editable numerical inputs, use calculator blocks with calculations, rather than a form that merely offers to recalculate. Forms append the current values automatically; do not put template placeholders in action prompts. Follow explicit user format requirements inside the appropriate block. Do not narrate JSON or describe the rendering system.`

/** Explicit venue requests use the live Places path rather than a planning round-trip. */
export function mapRequestForQuery(query: string) {
  const places = /\b(restaurants?|places to eat|dining|cafes?|coffee|hotels?|bars?|parks?|groceries|gas stations?)\b/i.test(query)
    && !/\b(compare|draw|polygon|route|zoning|demographics|population|boundaries)\b/i.test(query)
  return { key: 1, mode: places ? 'places' as const : 'auto' as const, query: places ? query
    .replace(/\bplaces to eat\b/gi, 'restaurants').replace(/^(?:show me|find me|show|find)\s+/i, '')
    .replace(/\s+on (?:a|the) map[.!?]*$/i, '').trim() : query }
}
