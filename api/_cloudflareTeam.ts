import { createHash, randomUUID } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareFlows } from './_cloudflareFlows'
import { autoPilotRoles, DEFAULT_TEAM, TEAM_VOICES, TeamError, type TeamMember } from './_team'
const idFor = (owner: string, request: string) => 'member_' + createHash('sha256').update(`${owner}\0${request}`).digest('hex').slice(0, 32)
const member = ({ id, name, role, responsibilities, workspace, extension, voice, active }: any): TeamMember => ({ id, name, role, responsibilities, workspace, extension, voice, active: !!active })

export class CloudflareTeam {
  constructor(readonly store: CloudflareStore) {}
  private async change<T>(owner: string, work: (rows: any[]) => T): Promise<T> {
    const scope = `team:${owner}`
    for (let attempt = 0; attempt < 5; attempt++) {
      const saved = await this.store.batch([
        { sql: 'SELECT id FROM nalu_users WHERE id=?', params: [owner] },
        { sql: 'SELECT revision FROM nalu_store_revisions WHERE scope=?', params: [scope] },
        { sql: 'SELECT * FROM nalu_team_members WHERE user_id=? ORDER BY extension', params: [owner] },
      ])
      if (!saved.results[0].results.length) throw new TeamError('Account not found.', 401)
      const rows: any[] = saved.results[2].results
      const before = JSON.stringify(rows)
      if (!rows.length) for (const [index, [name, role, responsibilities, workspace]] of DEFAULT_TEAM.entries()) rows.push({ id: idFor(owner, `seed:${index}`), name, role, responsibilities, workspace, extension: 100 + index, voice: TEAM_VOICES[index], active: 1, request_id: `seed:${index}`, fingerprint: 'seed' })
      const result = work(rows)
      if (JSON.stringify(rows) === before) return result
      const revision = randomUUID(), guard = 'EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=?3 AND revision=?4)'
      const committed = await this.store.batch([
        { sql: "INSERT INTO nalu_store_revisions(scope,revision) VALUES(?,'') ON CONFLICT DO NOTHING", params: [scope] },
        { sql: 'UPDATE nalu_store_revisions SET revision=? WHERE scope=? AND revision=? RETURNING revision', params: [revision, scope, String(saved.results[1].results[0]?.revision || '')] },
        { sql: `INSERT INTO nalu_team_members(id,user_id,name,role,responsibilities,workspace,extension,voice,active,request_id,fingerprint)
          SELECT json_extract(value,'$.id'),?1,json_extract(value,'$.name'),json_extract(value,'$.role'),json_extract(value,'$.responsibilities'),
            json_extract(value,'$.workspace'),json_extract(value,'$.extension'),json_extract(value,'$.voice'),json_extract(value,'$.active'),json_extract(value,'$.request_id'),json_extract(value,'$.fingerprint')
          FROM json_each(?2) WHERE ${guard}
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,responsibilities=excluded.responsibilities,workspace=excluded.workspace,active=excluded.active
          WHERE nalu_team_members.user_id=?1`, params: [owner, JSON.stringify(rows), scope, revision] },
      ])
      if (committed.results[1].results.length) return result
    }
    throw new TeamError('Your team changed while saving. Please try again.', 409)
  }
  async list(owner: string): Promise<TeamMember[]> {
    const roles = autoPilotRoles(await new CloudflareFlows(this.store).read(owner))
    return this.change(owner, rows => {
      if (roles) {
        const expected = new Set(roles.map(item => item.request))
        for (const row of rows) {
          if (row.request_id.startsWith('autopilot:') && !expected.has(row.request_id) || roles.length && /^seed:[1-9]$/.test(row.request_id)) row.active = 0
        }
        for (const role of roles) {
          const prior = rows.find(row => row.request_id === role.request)
          let name = role.name, index = 0
          while (rows.some(row => row.id !== prior?.id && row.name.toLowerCase() === name.toLowerCase())) name = role.name.slice(0, 40) + ' (AutoPilot' + (++index > 1 ? ' ' + index : '') + ')'
          if (prior) Object.assign(prior, { name, role: role.role, responsibilities: role.responsibilities, workspace: role.workspace, active: 1 })
          else rows.push(this.allocate(owner, rows, { ...role, name }, role.request, 'autopilot'))
        }
      }
      return rows.map(member)
    })
  }
  private allocate(owner: string, rows: any[], input: Record<string, string>, request: string, fingerprint: string) {
    const extension = Math.max(99, ...rows.map(row => row.extension)) + 1
    if (extension > 9999) throw new TeamError('No extensions are available.', 409)
    const voice = TEAM_VOICES.find(voice => !rows.some(row => row.voice === voice)) || TEAM_VOICES[rows.length % TEAM_VOICES.length]
    return { id: idFor(owner, request), name: input.name, role: input.role, responsibilities: input.responsibilities, workspace: input.workspace, extension, voice, active: 1, request_id: request, fingerprint }
  }
  async create(owner: string, input: Record<string, string>, request: string, fingerprint: string): Promise<TeamMember> {
    return this.change(owner, rows => {
      const prior = rows.find(row => row.request_id === request)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError('This requestId was used for a different role.', 409)
        return member(prior)
      }
      if (rows.some(row => row.name.toLowerCase() === input.name.toLowerCase())) throw new TeamError('A team member already has that name.', 409)
      const row = this.allocate(owner, rows, input, request, fingerprint)
      rows.push(row); return member(row)
    })
  }
}
