import { CloudflareStore } from './_cloudflareStore'
import { CloudflareTeam } from './_cloudflareTeam'
import { createHash } from 'node:crypto'

export type TeamClient = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }
export type TeamMember = {
  id: string; name: string; role: string; responsibilities: string; workspace: string;
  extension: number; voice: string; active: boolean;
}

// Adult English neural voices documented by AWS Polly and supported by TeXML Say.
// Keep existing assignments stable. Larger AutoPilot teams reuse voices;
// extension and role identity remain unique even beyond the voice catalog.
export const TEAM_VOICES = ['Amy', 'Brian', 'Joanna', 'Matthew', 'Emma', 'Olivia',
  'Kendra', 'Joey', 'Salli', 'Kimberly', 'Arthur', 'Danielle', 'Gregory', 'Ruth',
  'Stephen', 'Niamh', 'Aria', 'Ayanda', 'Kajal', 'Jasmine'].map(v => `Polly.${v}-Neural`)

export const DEFAULT_TEAM = [
  ['Nalu', 'Chief of staff', 'Coordinate the team, answer general questions, choose the right specialist, and report task progress.', 'train'],
  ['Atlas', 'Engineering lead', 'Build and debug the desktop app, developer tools, CLI, repository code, tests, and releases.', 'naludesktop'],
  ['Maya', 'Creative director', 'Create images, designs, brand assets, presentations, and other visual work.', 'train'],
  ['Theo', 'Research lead', 'Research questions, analyze evidence, and prepare cited reports.', 'train'],
  ['Iris', 'Product lead', 'Plan product work, write requirements, and improve the mobile app experience.', 'nalumobile'],
  ['Harper', 'Operations lead', 'Run requested AutoPilot workflows, coordinate projects, and monitor task delivery.', 'train'],
  ['Grace', 'Finance analyst', 'Analyze financial data, budgets, spreadsheets, and business performance.', 'train'],
  ['Leo', 'Sales lead', 'Prepare sales materials, proposals, and customer research.', 'train'],
  ['Sofia', 'Marketing lead', 'Develop campaigns, copy, content, and audience research.', 'train'],
  ['Chloe', 'Customer experience lead', 'Investigate customer issues, prepare support answers, and improve documentation.', 'train'],
] as const

export class TeamError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

let schemaReady = false
export async function ensureTeamSchema(c: TeamClient | CloudflareStore) {
  if (c instanceof CloudflareStore || schemaReady) return
  await c.query('BEGIN')
  try {
  await c.query('SELECT pg_advisory_xact_lock(72816420)')
  await c.query(`CREATE TABLE IF NOT EXISTS nalu_team_members (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, role TEXT NOT NULL, responsibilities TEXT NOT NULL,
    workspace TEXT NOT NULL, extension INTEGER NOT NULL CHECK (extension BETWEEN 100 AND 9999),
    voice TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, extension), UNIQUE(user_id, request_id)
  );
  ALTER TABLE nalu_team_members DROP CONSTRAINT IF EXISTS nalu_team_members_user_id_voice_key;
  CREATE UNIQUE INDEX IF NOT EXISTS nalu_team_names ON nalu_team_members (user_id, lower(name));`)
  await c.query('COMMIT')
  schemaReady = true
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error }
}

const fields = 'id,name,role,responsibilities,workspace,extension,voice,active'
const idFor = (uid: string, request: string) => 'member_' + createHash('sha256').update(`${uid}\0${request}`).digest('hex').slice(0, 32)

async function seedLocked(c: TeamClient, uid: string) {
  const existing = await c.query('SELECT id FROM nalu_team_members WHERE user_id=$1 LIMIT 1', [uid])
  if (existing.rows.length) return
  for (const [index, [name, role, responsibilities, workspace]] of DEFAULT_TEAM.entries()) {
    const request = `seed:${index}`
    await c.query(`INSERT INTO nalu_team_members
      (id,user_id,name,role,responsibilities,workspace,extension,voice,request_id,fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'seed')`,
    [idFor(uid, request), uid, name, role, responsibilities, workspace, 100 + index, TEAM_VOICES[index], request])
  }
}

async function withTeam<T>(c: TeamClient, uid: string, work: () => Promise<T>): Promise<T> {
  await ensureTeamSchema(c)
  await c.query('BEGIN')
  try {
    // Serialize allocation on the account row, including first access/seeding.
    const user = await c.query('SELECT id FROM nalu_users WHERE id=$1 FOR UPDATE', [uid])
    if (!user.rows.length) throw new TeamError('Account not found.', 401)
    await seedLocked(c, uid)
    const result = await work()
    await c.query('COMMIT')
    return result
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error }
}

export function listTeam(c: TeamClient | CloudflareStore, uid: string): Promise<TeamMember[]> {
  if (c instanceof CloudflareStore) return new CloudflareTeam(c).list(uid)
  return withTeam(c, uid, async () => {
    await syncAutoPilotRoles(c,uid)
    return (await c.query(`SELECT ${fields} FROM nalu_team_members WHERE user_id=$1 ORDER BY extension`, [uid])).rows
  })
}

export function autoPilotRoles(value:unknown){
  for(let i=0;i<6 && typeof value==='string';i++){try{value=JSON.parse(value)}catch{return null}}
  if(!Array.isArray(value))return null
  const roles=new Map<string,{request:string;name:string;role:string;responsibilities:string;workspace:string}>()
  for(const flow of value){
    if(!flow||!Array.isArray(flow.nodes))continue
    for(const node of flow.nodes){
      if(node?.type!=='agent'||(!node.role&&!node.roleTitle))continue
      const title=String(node.roleTitle||node.label||node.role||'').replace(/[\x00-\x1f]/g,' ').trim().slice(0,60)
      if(!title)continue
      const key=node.role && node.role!=='custom'?String(node.role):'custom:'+title.toLowerCase()
      const request='autopilot:'+createHash('sha256').update(key).digest('hex').slice(0,32)
      const persona=String(node.role||'').startsWith('hf-') && !/analyst|manager|macro|events/i.test(title)
      const role=persona?title+' — AI investment persona':title
      const notes=[persona?'An AI role inspired by this investor’s approach, never the actual person.':'AutoPilot company role.',flow.company?.what,flow.company?.mission,node.roleNotes||node.prompt].filter(x=>typeof x==='string'&&x.trim()).join(' ').replace(/[\x00-\x1f]/g,' ').slice(0,1200)
      if(!roles.has(request))roles.set(request,{request,name:title,role:role.slice(0,80),responsibilities:notes,workspace:'train'})
    }
  }
  return [...roles.values()]
}
async function syncAutoPilotRoles(c:TeamClient,uid:string){
  const saved=(await c.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-agent-flows'",[uid])).rows[0]
  if(!saved)return
  const roles=autoPilotRoles(saved.value)
  if(!roles)return // An unreadable sync must never retire the directory.
  const rows=(await c.query(`SELECT ${fields},request_id FROM nalu_team_members WHERE user_id=$1 ORDER BY extension`,[uid])).rows
  const expected=new Set(roles.map(r=>r.request))
  for(const row of rows){
    if(row.active && row.request_id?.startsWith('autopilot:') && !expected.has(row.request_id))await c.query('UPDATE nalu_team_members SET active=FALSE WHERE id=$1 AND user_id=$2',[row.id,uid])
    if(row.active && roles.length && /^seed:[1-9]$/.test(row.request_id))await c.query('UPDATE nalu_team_members SET active=FALSE WHERE id=$1 AND user_id=$2',[row.id,uid])
  }
  for(const item of roles){
    const prior=rows.find(r=>r.request_id===item.request)
    let name=item.name,index=0
    while(rows.some(r=>r.id!==prior?.id && r.name.toLowerCase()===name.toLowerCase())){index++;name=item.name.slice(0,40)+' (AutoPilot'+(index>1?' '+index:'')+')'}
    if(prior){
      if(prior.active && prior.name===name && prior.role===item.role && prior.responsibilities===item.responsibilities && prior.workspace===item.workspace)continue
      await c.query('UPDATE nalu_team_members SET name=$3,role=$4,responsibilities=$5,workspace=$6,active=TRUE WHERE id=$1 AND user_id=$2',[prior.id,uid,name,item.role,item.responsibilities,item.workspace])
    }else{
      const extension=Math.max(99,...rows.map(r=>r.extension))+1
      if(extension>9999)throw new TeamError('No extensions are available.',409)
      const voice=TEAM_VOICES.find(v=>!rows.some(r=>r.voice===v))||TEAM_VOICES[rows.length%TEAM_VOICES.length]
      const id=idFor(uid,item.request)
      await c.query(`INSERT INTO nalu_team_members(id,user_id,name,role,responsibilities,workspace,extension,voice,request_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'autopilot')`,[id,uid,name,item.role,item.responsibilities,item.workspace,extension,voice,item.request])
      rows.push({id,name,extension,voice,request_id:item.request})
    }
  }
}

export async function createTeamRole(c: TeamClient | CloudflareStore, uid: string, body: Record<string, unknown>): Promise<TeamMember> {
  const limits = { name: 60, role: 80, responsibilities: 1200, workspace: 2048 } as const
  const input: Record<string, string> = {}
  for (const [key, max] of Object.entries(limits)) {
    const value = body[key]
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f]/.test(value)) throw new TeamError(`Provide a ${key} within ${max} characters.`)
    input[key] = value.trim()
  }
  if (input.workspace === 'auto') {
    const purpose = input.role + ' ' + input.responsibilities
    input.workspace = /\b(?:mobile|ios|android)\b/i.test(purpose) ? 'nalumobile' : /\b(?:desktop|cli|developer tools)\b/i.test(purpose) ? 'naludesktop' : 'train'
  }
  const request = body.requestId
  if (typeof request !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request) || request.startsWith('seed:')) throw new TeamError('A valid requestId is required.')
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  if (c instanceof CloudflareStore) return new CloudflareTeam(c).create(uid,input,request,fingerprint)
  return withTeam(c, uid, async () => {
    const prior = await c.query(`SELECT ${fields},fingerprint FROM nalu_team_members WHERE user_id=$1 AND request_id=$2`, [uid, request])
    if (prior.rows.length) {
      const { fingerprint: saved, ...member } = prior.rows[0]
      if (saved !== fingerprint) throw new TeamError('This requestId was used for a different role.', 409)
      return member as TeamMember
    }
    const rows = (await c.query('SELECT name,extension,voice FROM nalu_team_members WHERE user_id=$1', [uid])).rows
    if (rows.some(m => m.name.toLowerCase() === input.name.toLowerCase())) throw new TeamError('A team member already has that name.', 409)
    const voice = TEAM_VOICES.find(v => !rows.some(m => m.voice === v)) || TEAM_VOICES[rows.length % TEAM_VOICES.length]
    const extension = Math.max(99, ...rows.map(m => m.extension)) + 1
    if (extension > 9999) throw new TeamError('No extensions are available.', 409)
    const created = await c.query(`INSERT INTO nalu_team_members
      (id,user_id,name,role,responsibilities,workspace,extension,voice,request_id,fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${fields}`,
    [idFor(uid, request), uid, input.name, input.role, input.responsibilities, input.workspace, extension, voice, request, fingerprint])
    return created.rows[0]
  })
}

/** Exact extension or explicitly requested name; ordinary mentions don't transfer. */
export function selectTeamMember(members: TeamMember[], said: string): TeamMember | undefined {
  const digits: Record<string, string> = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }
  const spoken = said.toLowerCase().replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, word => digits[word]).replace(/(\d)\s+(?=\d)/g, '$1')
  const extension = spoken.trim().match(/^(?:please\s+)?(?:(?:connect|transfer|switch)(?: me)? to\s+)?(?:extension\s*|ext\.?\s*)?(\d{3,4})[.!]?$/i)
  if (extension) return members.find(m => m.active && m.extension === Number(extension[1]))
  const target = said.trim().replace(/^(?:(?:please\s+)?(?:(?:let me|(?:can|could|may) I(?: please)?|I(?:'d| would) like to) (?:speak|talk) (?:to|with)|put me through to|(?:speak|talk|transfer|connect|switch)(?: me)? to|ask)\s+)/i, '').replace(/[.!?]$/, '')
  const matches=members.filter(m => m.active && [m.name,m.role].some(value=>value.toLowerCase()===target.toLowerCase().replace(/^the /i,'')))
  return matches.length===1?matches[0]:undefined
}
