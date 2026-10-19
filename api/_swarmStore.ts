import { randomUUID } from 'node:crypto'
import { CloudflareStore, type CloudflareStatement } from './_cloudflareStore'
import type { ConnectionClient } from './_connectionStore'
import type { SwarmState, SwarmThread, SwarmAgentId } from '../client/src/components/workspace/design/swarmTypes'

export type SwarmJobStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
export interface SwarmJob {
  id: string; projectId: string; thread: SwarmThread; kind: 'reply' | 'task'; taskId?: string; turnId?: string
  speaker: SwarmAgentId; status: SwarmJobStatus; input: string; requestId: string
  createdAt: number; updatedAt: number; leaseToken?: string; leaseUntil?: number; attempts: number
  progress?: number; summary?: string; result?: string; error?: string
  /** A failed refund remains unconfirmed; this flag never retries providers. */
  quotaCleanupPending?: boolean
  artifact?: { type: string; [key: string]: unknown }
}
export interface SwarmSnapshot { state: SwarmState; jobs: SwarmJob[]; revision: number }
export type SwarmMutation = (draft: SwarmSnapshot) => SwarmSnapshot | void
export const SWARM_LEASE_MS = 120_000
export const SWARM_MAX_STATE_BYTES = 3_000_000
export const SWARM_MAX_SNAPSHOT_BYTES = 12_000_000
const RECOVERY_BYTES = 16_000
export class SwarmStoreLimitError extends Error {
  readonly status = 429
  constructor() { super('Swarm history has reached its supported size. Existing work is preserved; no new content was saved.') }
}
const INTERRUPTED = 'Work was interrupted after its worker lease expired. Retry explicitly to start a new run.'
const AGENTS = new Set(['Nalu', 'Rocky', 'Milo'])
const STATUSES = new Set(['queued', 'running', 'waiting', 'done', 'failed', 'cancelled'])
const TABLES = ['projects', 'rooms', 'messages', 'tasks', 'task_threads', 'turns', 'jobs'] as const
type Table = typeof TABLES[number]
type RecordRow = { id: string; projectId?: string; thread?: string; status?: string; requestId?: string; leaseUntil?: number; updatedAt?: number; [key: string]: unknown }
type Records = Record<Table, RecordRow[]>
const empty = (): SwarmSnapshot => ({ revision: 0, state: { version: 1, mode: 'live', projects: [], messages: [], tasks: [], turns: [] }, jobs: [] })
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/.test(value)
const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
const ownerKey = (owner: string) => { if (!validId(owner)) throw new Error('A valid Swarm account is required.'); return owner }
const queues = new WeakMap<object, Promise<unknown>>()
const schemas = new WeakMap<object, Promise<void>>()

// A shared pg.Client cannot have overlapping interactive transactions, even
// when two SwarmStore instances use it. Cloudflare batches are atomic remotely.
async function serial<T>(client: object, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(client) || Promise.resolve()
  const result = prior.catch(() => {}).then(fn)
  queues.set(client, result.catch(() => {}))
  return result
}

const pgTables = TABLES.map(table => `CREATE TABLE IF NOT EXISTS nalu_swarm_${table} (
  owner_id TEXT NOT NULL REFERENCES nalu_swarm_accounts(owner_id) ON DELETE CASCADE,
  id TEXT NOT NULL, project_id TEXT, thread TEXT, payload JSONB NOT NULL,
  ${table === 'jobs' ? 'status TEXT NOT NULL, request_id TEXT NOT NULL, lease_until BIGINT, updated_at BIGINT NOT NULL,' : ''}
  PRIMARY KEY(owner_id,id)${table === 'jobs' ? ', UNIQUE(owner_id,request_id)' : ''}
); CREATE INDEX IF NOT EXISTS nalu_swarm_${table}_project ON nalu_swarm_${table}(owner_id,project_id);`).join('\n')

function records(snapshot: SwarmSnapshot): Records {
  const { state } = snapshot
  const rooms = state.projects.flatMap(project => (['group', ...project.members] as SwarmThread[]).map(thread => ({ id: JSON.stringify([project.id, thread]), projectId: project.id, thread })))
  const links = state.tasks.flatMap(task => (task.threads || []).map(thread => ({ id: JSON.stringify([task.id, thread]), projectId: task.projectId, taskId: task.id, thread })))
  return { projects: state.projects, rooms, messages: state.messages, tasks: state.tasks, task_threads: links, turns: state.turns, jobs: snapshot.jobs } as unknown as Records
}

function assertSnapshot(value: SwarmSnapshot, previous?: SwarmSnapshot): void {
  const state = value.state
  if (state.version !== 1 || state.mode !== 'live') throw new Error('Only real Swarm state can be saved.')
  const projectMap = new Map(state.projects.map(project => [project.id, project]))
  const room = (projectId: string, thread: string) => {
    const project = projectMap.get(projectId)
    return !!project && (thread === 'group' || project.members.includes(thread as SwarmAgentId))
  }
  for (const rows of Object.values(records(value))) {
    const ids = new Set<string>()
    for (const row of rows) {
      if (!validId(row.id) || ids.has(row.id)) throw new Error('Swarm records require unique, valid IDs.')
      ids.add(row.id)
    }
  }
  for (const project of state.projects) {
    if (!Array.isArray(project.members) || !project.members.length || new Set(project.members).size !== project.members.length || project.members.some(member => !AGENTS.has(member))) throw new Error('Invalid Swarm membership.')
    if (typeof project.title !== 'string' || typeof project.brief !== 'string' || !timestamp(project.createdAt) || !timestamp(project.updatedAt)) throw new Error('Invalid Swarm project.')
  }
  for (const task of state.tasks) {
    if (!projectMap.get(task.projectId)?.members.includes(task.assignee) || !Array.isArray(task.threads) || !task.threads.length || new Set(task.threads).size !== task.threads.length || task.threads.some(thread => !room(task.projectId, thread))) throw new Error('Work must be explicitly linked to valid Swarm conversations.')
    if ((!STATUSES.has(task.status) && task.status !== 'paused') || !timestamp(task.updatedAt)) throw new Error('Invalid Swarm work status.')
  }
  for (const message of state.messages) {
    if (!room(message.projectId, message.thread) || (message.speaker !== 'You' && !projectMap.get(message.projectId)?.members.includes(message.speaker)) || message.sample || typeof message.content !== 'string' || !timestamp(message.createdAt)) throw new Error('Invalid Swarm message.')
  }
  const messages = new Map(state.messages.map(message => [message.id, message]))
  const turns = new Map(state.turns.map(turn => [turn.id, turn]))
  for (const turn of state.turns) {
    const source = messages.get(turn.userMessageId)
    if (!room(turn.projectId, turn.thread) || !projectMap.get(turn.projectId)?.members.includes(turn.replySpeaker) || !source || source.projectId !== turn.projectId || source.thread !== turn.thread || !['pending', 'completed', 'cancelled', 'failed'].includes(turn.status)) throw new Error('Invalid Swarm turn association.')
  }
  const tasks = new Map(state.tasks.map(task => [task.id, task]))
  const requests = new Set<string>()
  for (const job of value.jobs) {
    if (!room(job.projectId, job.thread) || !projectMap.get(job.projectId)?.members.includes(job.speaker) || !STATUSES.has(job.status) || !['reply', 'task'].includes(job.kind) || !validId(job.requestId) || requests.has(job.requestId) || typeof job.input !== 'string') throw new Error('Invalid Swarm job.')
    requests.add(job.requestId)
    if (!timestamp(job.createdAt) || !timestamp(job.updatedAt) || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || (job.progress !== undefined && (!Number.isFinite(job.progress) || job.progress < 0 || job.progress > 1))) throw new Error('Invalid Swarm job progress.')
    if (job.quotaCleanupPending !== undefined && typeof job.quotaCleanupPending !== 'boolean') throw new Error('Invalid Swarm refund status.')
    if (job.status === 'running' && (!validId(job.leaseToken) || !timestamp(job.leaseUntil))) throw new Error('Running Swarm work requires a lease.')
    const task = job.taskId ? tasks.get(job.taskId) : undefined, turn = job.turnId ? turns.get(job.turnId) : undefined
    if (job.kind === 'task' && (!task || task.projectId !== job.projectId || !task.threads?.includes(job.thread))) throw new Error('Invalid Swarm job work association.')
    if (job.kind === 'reply' && (!turn || turn.projectId !== job.projectId || turn.thread !== job.thread)) throw new Error('Invalid Swarm job turn association.')
  }
  // Identity and input define idempotency. A retry starts a NEW job; neither a
  // finished nor interrupted attempt can be changed into a fresh request.
  if (previous) {
    const oldJobs = new Map(previous.jobs.map(job => [job.id, job]))
    for (const job of value.jobs) {
      const old = oldJobs.get(job.id)
      if (!old) continue
      for (const key of ['requestId', 'projectId', 'thread', 'kind', 'taskId', 'turnId', 'speaker', 'input', 'createdAt'] as const) if (job[key] !== old[key]) throw new Error('A Swarm job request cannot be rewritten.')
      if (old.status !== 'queued' && job.status === 'queued') throw new Error('Retry Swarm work with a new job ID.')
      if (['done', 'failed', 'cancelled'].includes(old.status) && job.status !== old.status) throw new Error('A finished Swarm attempt cannot be restarted.')
    }
  }
}

function assemble(revision: unknown, data: Partial<Record<Table, RecordRow[]>>): SwarmSnapshot {
  const snapshot = empty()
  snapshot.revision = Number(revision || 0)
  snapshot.state.projects = (data.projects || []) as unknown as SwarmState['projects']
  snapshot.state.messages = (data.messages || []) as unknown as SwarmState['messages']
  snapshot.state.tasks = (data.tasks || []) as unknown as SwarmState['tasks']
  snapshot.state.turns = (data.turns || []) as unknown as SwarmState['turns']
  snapshot.jobs = (data.jobs || []) as unknown as SwarmJob[]
  snapshot.state.messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  snapshot.jobs.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  assertSnapshot(snapshot)
  return snapshot
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function without(value: object, fields: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)))
}
/** Small terminal transitions remain possible when content has filled the
 * ordinary quota. This never admits new work, user content, or larger results. */
function terminalRecovery(previous: SwarmSnapshot, next: SwarmSnapshot): boolean {
  if (!same(previous.state.projects, next.state.projects) || previous.jobs.length !== next.jobs.length) return false
  const changed: SwarmJob[] = []
  for (const old of previous.jobs) {
    const job = next.jobs.find(item => item.id === old.id)
    if (!job) return false
    if (same(old, job)) continue
    const ending = ['queued', 'running', 'waiting'].includes(old.status) && ['failed', 'cancelled'].includes(job.status)
    const notingRefund = ['failed', 'cancelled'].includes(old.status) && job.status === old.status
      && job.quotaCleanupPending === true && old.quotaCleanupPending !== true
    if ((!ending && !notingRefund)
      || job.leaseToken !== undefined || job.leaseUntil !== undefined || (job.summary?.length || 0) > 512 || (job.error?.length || 0) > 512
      || (job.progress !== undefined && job.progress !== old.progress)
      || !same(without(old, ['status', 'updatedAt', 'leaseToken', 'leaseUntil', 'summary', 'error', 'progress', 'quotaCleanupPending']), without(job, ['status', 'updatedAt', 'leaseToken', 'leaseUntil', 'summary', 'error', 'progress', 'quotaCleanupPending']))) return false
    changed.push(job)
  }
  if (!changed.length) return false
  if (previous.state.tasks.length !== next.state.tasks.length || previous.state.turns.length !== next.state.turns.length) return false
  for (const old of previous.state.tasks) {
    const task = next.state.tasks.find(item => item.id === old.id)
    if (!task) return false
    if (same(old, task)) continue
    if (!changed.some(job => job.taskId === task.id && (!task.executionId || task.executionId === job.id)) || !['failed', 'cancelled'].includes(task.status)
      || task.summary.length > 512 || (task.progress !== undefined && task.progress !== old.progress)
      || !same(without(old, ['status', 'updatedAt', 'summary', 'progress']), without(task, ['status', 'updatedAt', 'summary', 'progress']))) return false
  }
  for (const old of previous.state.turns) {
    const turn = next.state.turns.find(item => item.id === old.id)
    if (!turn) return false
    if (same(old, turn)) continue
    if (!changed.some(job => job.turnId === turn.id) || !['failed', 'cancelled'].includes(turn.status)
      || !same(without(old, ['status', 'updatedAt']), without(turn, ['status', 'updatedAt']))) return false
  }
  const priorMessages = new Map(previous.state.messages.map(message => [message.id, message]))
  for (const [id, message] of priorMessages) if (!same(message, next.state.messages.find(item => item.id === id))) return false
  const added = next.state.messages.filter(message => !priorMessages.has(message.id))
  return added.length <= changed.length && added.every(message => message.content.length <= 160 && changed.some(job => job.kind === 'reply'
    && message.id === `${job.id}:reply` && message.projectId === job.projectId && message.thread === job.thread && message.speaker === job.speaker))
}

function assertCapacity(previous: SwarmSnapshot, next: SwarmSnapshot) {
  const stateBytes = Buffer.byteLength(JSON.stringify(next.state)), totalBytes = Buffer.byteLength(JSON.stringify(next))
  if (stateBytes <= SWARM_MAX_STATE_BYTES && totalBytes <= SWARM_MAX_SNAPSHOT_BYTES) return
  // Never prevent a caller from reducing an already full history.
  if (stateBytes <= Buffer.byteLength(JSON.stringify(previous.state)) && totalBytes <= Buffer.byteLength(JSON.stringify(previous))) return
  if (stateBytes <= SWARM_MAX_STATE_BYTES + RECOVERY_BYTES && totalBytes <= SWARM_MAX_SNAPSHOT_BYTES + RECOVERY_BYTES && terminalRecovery(previous, next)) return
  throw new SwarmStoreLimitError()
}

export class SwarmStore {
  constructor(readonly client: ConnectionClient) {}

  private async ensure(): Promise<void> {
    if (this.client instanceof CloudflareStore) return // D1 migrations are explicit deployment work.
    const client = this.client
    let ready = schemas.get(client)
    if (!ready) {
      ready = serial(client, async () => {
        await client.query('BEGIN')
        try {
          // IF NOT EXISTS does not serialize PostgreSQL catalog/type creation
          // across independent connections. A transaction-scoped lock also
          // releases automatically if initialization fails or the client dies.
          await client.query("SELECT pg_advisory_xact_lock(hashtext('nalu_swarm_schema_v1'))")
          await client.query(`CREATE TABLE IF NOT EXISTS nalu_swarm_accounts (
            owner_id TEXT PRIMARY KEY REFERENCES nalu_users(id) ON DELETE CASCADE,
            revision BIGINT NOT NULL DEFAULT 0 CHECK(revision>=0), write_token TEXT
          ); ${pgTables}
          CREATE INDEX IF NOT EXISTS nalu_swarm_jobs_due ON nalu_swarm_jobs(status,lease_until,updated_at,owner_id);`)
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        }
      })
      schemas.set(client, ready)
      ready.catch(() => schemas.delete(client))
    }
    await ready
  }

  async read(owner: string): Promise<SwarmSnapshot> {
    ownerKey(owner); await this.ensure()
    if (this.client instanceof CloudflareStore) {
      // A D1 batch gives a coherent read of revision and all entity families.
      const result = await this.client.batch([
        { sql: 'SELECT revision FROM nalu_swarm_accounts WHERE owner_id=?', params: [owner] },
        ...TABLES.map(table => ({ sql: `SELECT payload FROM nalu_swarm_${table} WHERE owner_id=? ORDER BY id`, params: [owner] })),
      ])
      const data: Partial<Record<Table, RecordRow[]>> = {}
      TABLES.forEach((table, i) => { data[table] = result.results[i + 1].results.map(row => JSON.parse(String(row.payload)) as RecordRow) })
      return assemble(result.results[0].results[0]?.revision, data)
    }
    const client = this.client
    return serial(client, async () => {
      const fields = TABLES.map(table => `(SELECT COALESCE(jsonb_agg(payload ORDER BY id),'[]'::jsonb) FROM nalu_swarm_${table} WHERE owner_id=$1) AS ${table}`).join(',')
      const row = (await client.query(`SELECT COALESCE((SELECT revision FROM nalu_swarm_accounts WHERE owner_id=$1),0) AS revision,${fields}`, [owner])).rows[0]
      return assemble(row?.revision, row || {})
    })
  }

  private async commit(owner: string, previous: SwarmSnapshot, next: SwarmSnapshot, lease?: { jobId: string; token: string }): Promise<boolean> {
    const before = records(previous), after = records(next)
    const changes = TABLES.map(table => {
      const old = new Map(before[table].map(row => [row.id, JSON.stringify(row)])), ids = new Set(after[table].map(row => row.id))
      return { table, deleted: before[table].filter(row => !ids.has(row.id)).map(row => row.id), rows: after[table].filter(row => old.get(row.id) !== JSON.stringify(row)) }
    })
    if (Buffer.byteLength(JSON.stringify(changes)) > 1_300_000) throw new Error('This Swarm update is too large. Save smaller changes.')
    if (this.client instanceof CloudflareStore) {
      const writeToken = randomUUID()
      const guard = 'EXISTS(SELECT 1 FROM nalu_swarm_accounts WHERE owner_id=?1 AND revision=?2 AND write_token=?4)'
      const statements: CloudflareStatement[] = [{ sql: 'INSERT INTO nalu_swarm_accounts(owner_id,revision) VALUES(?,0) ON CONFLICT(owner_id) DO NOTHING', params: [owner] }]
      statements.push({ sql: `UPDATE nalu_swarm_accounts SET write_token=?3 WHERE owner_id=?1 AND revision=?2${lease ? " AND EXISTS(SELECT 1 FROM nalu_swarm_jobs WHERE owner_id=?1 AND id=?4 AND status='running' AND json_extract(payload,'$.leaseToken')=?5 AND lease_until>(julianday('now')-2440587.5)*86400000)" : ''}`, params: [owner, previous.revision, writeToken, ...(lease ? [lease.jobId, lease.token] : [])] })
      for (const { table, deleted, rows } of changes) {
        if (deleted.length) statements.push({ sql: `DELETE FROM nalu_swarm_${table} WHERE owner_id=?1 AND id IN(SELECT value FROM json_each(?3)) AND ${guard}`, params: [owner, previous.revision, JSON.stringify(deleted), writeToken] })
        if (!rows.length) continue
        const job = table === 'jobs'
        statements.push({
          sql: `INSERT INTO nalu_swarm_${table}(owner_id,id,project_id,thread,payload${job ? ',status,request_id,lease_until,updated_at' : ''})
            SELECT ?1,json_extract(value,'$.id'),json_extract(value,'$.projectId'),json_extract(value,'$.thread'),value${job ? ",json_extract(value,'$.status'),json_extract(value,'$.requestId'),json_extract(value,'$.leaseUntil'),json_extract(value,'$.updatedAt')" : ''}
            FROM json_each(?3) WHERE ${guard}
            ON CONFLICT(owner_id,id) DO UPDATE SET project_id=excluded.project_id,thread=excluded.thread,payload=excluded.payload${job ? ',status=excluded.status,request_id=excluded.request_id,lease_until=excluded.lease_until,updated_at=excluded.updated_at' : ''}`,
          params: [owner, previous.revision, JSON.stringify(rows), writeToken],
        })
      }
      // Every preceding statement is fenced by this same revision. An atomic
      // batch with a stale revision writes nothing; no fake SQL transaction.
      statements.push({ sql: 'UPDATE nalu_swarm_accounts SET revision=revision+1,write_token=NULL WHERE owner_id=? AND revision=? AND write_token=? RETURNING revision', params: [owner, previous.revision, writeToken] })
      const result = await this.client.batch(statements)
      return result.results[result.results.length - 1].results.length > 0
    }
    const client = this.client
    return serial(client, async () => {
      await client.query('BEGIN')
      try {
        await client.query('INSERT INTO nalu_swarm_accounts(owner_id,revision) VALUES($1,0) ON CONFLICT(owner_id) DO NOTHING', [owner])
        const revision = (await client.query('SELECT revision FROM nalu_swarm_accounts WHERE owner_id=$1 FOR UPDATE', [owner])).rows[0]?.revision
        if (Number(revision) !== previous.revision) { await client.query('ROLLBACK'); return false }
        if (lease) {
          const valid = (await client.query("SELECT id FROM nalu_swarm_jobs WHERE owner_id=$1 AND id=$2 AND status='running' AND payload->>'leaseToken'=$3 AND lease_until>EXTRACT(EPOCH FROM clock_timestamp())*1000", [owner, lease.jobId, lease.token])).rows.length
          if (!valid) { await client.query('ROLLBACK'); return false }
        }
        for (const { table, deleted, rows } of changes) {
          if (deleted.length) await client.query(`DELETE FROM nalu_swarm_${table} WHERE owner_id=$1 AND id IN(SELECT jsonb_array_elements_text($2::jsonb))`, [owner, JSON.stringify(deleted)])
          if (!rows.length) continue
          const job = table === 'jobs'
          await client.query(`INSERT INTO nalu_swarm_${table}(owner_id,id,project_id,thread,payload${job ? ',status,request_id,lease_until,updated_at' : ''})
            SELECT $1,value->>'id',value->>'projectId',value->>'thread',value${job ? ",value->>'status',value->>'requestId',(value->>'leaseUntil')::bigint,(value->>'updatedAt')::bigint" : ''}
            FROM jsonb_array_elements($2::jsonb)
            ON CONFLICT(owner_id,id) DO UPDATE SET project_id=excluded.project_id,thread=excluded.thread,payload=excluded.payload${job ? ',status=excluded.status,request_id=excluded.request_id,lease_until=excluded.lease_until,updated_at=excluded.updated_at' : ''}`, [owner, JSON.stringify(rows)])
        }
        await client.query('UPDATE nalu_swarm_accounts SET revision=revision+1 WHERE owner_id=$1', [owner])
        await client.query('COMMIT'); return true
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    })
  }

  /** Callback must be synchronous and side-effect free; conflict retries can
   * invoke it again. Transport/uncertain-write errors are NEVER retried here. */
  async mutate(owner: string, mutation: SwarmMutation): Promise<SwarmSnapshot> {
    return this.mutateInternal(owner, mutation)
  }

  private async mutateInternal(owner: string, mutation: SwarmMutation, lease?: { jobId: string; token: string }): Promise<SwarmSnapshot> {
    ownerKey(owner)
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = await this.read(owner), draft = copy(previous)
      const returned = mutation(draft)
      if (returned && typeof (returned as unknown as { then?: unknown }).then === 'function') throw new Error('Swarm mutations must be synchronous.')
      const next = returned || draft
      next.revision = previous.revision
      assertSnapshot(next, previous)
      if (JSON.stringify(next) === JSON.stringify(previous)) return previous
      assertCapacity(previous, next)
      if (await this.commit(owner, previous, next, lease)) { next.revision++; return next }
    }
    throw new Error('Swarm changed repeatedly while saving. Refresh and try again.')
  }

  async dueOwners(limit = 20): Promise<string[]> {
    await this.ensure()
    const cap = Math.max(1, Math.min(100, Math.floor(limit) || 20)), now = Date.now()
    if (this.client instanceof CloudflareStore) return (await this.client.query(`SELECT owner_id,MIN(updated_at) AS oldest FROM nalu_swarm_jobs WHERE status='queued' OR (status='running' AND lease_until<=?) GROUP BY owner_id ORDER BY oldest LIMIT ?`, [now, cap])).results.map(row => String(row.owner_id))
    const client = this.client
    return serial(client, async () => (await client.query(`SELECT owner_id,MIN(updated_at) AS oldest FROM nalu_swarm_jobs WHERE status='queued' OR (status='running' AND lease_until<=$1) GROUP BY owner_id ORDER BY oldest LIMIT $2`, [now, cap])).rows.map(row => String(row.owner_id)))
  }

  async claim(owner: string, jobId?: string, maxActive = 3): Promise<SwarmJob | null> {
    const now = Date.now(), token = randomUUID(), maximum = Math.max(1, Math.min(3, Math.floor(maxActive) || 3))
    const saved = await this.mutate(owner, draft => {
      for (const job of draft.jobs) {
        if (job.status !== 'running' || (job.leaseUntil || 0) > now) continue
        job.status = 'failed'; job.error = INTERRUPTED; job.summary = INTERRUPTED; job.updatedAt = now
        delete job.leaseToken; delete job.leaseUntil
        const turn = draft.state.turns.find(item => item.id === job.turnId)
        if (turn?.status === 'pending') { turn.status = 'failed'; turn.updatedAt = now }
        const task = draft.state.tasks.find(item => item.id === job.taskId)
        if (task && (!task.executionId || task.executionId === job.id) && ['queued', 'running', 'waiting'].includes(task.status)) { task.status = 'failed'; task.summary = INTERRUPTED; task.updatedAt = now }
      }
      // Preserve the interruption sweep even when it uses the small terminal
      // recovery allowance. Do not mix it with starting fresh work at the cap.
      if (Buffer.byteLength(JSON.stringify(draft.state)) > SWARM_MAX_STATE_BYTES || Buffer.byteLength(JSON.stringify(draft)) > SWARM_MAX_SNAPSHOT_BYTES) return
      if (draft.jobs.filter(job => job.status === 'running').length >= maximum) return
      const job = draft.jobs.find(item => item.status === 'queued' && (!jobId || item.id === jobId))
      if (!job) return
      job.status = 'running'; job.leaseToken = token; job.leaseUntil = now + SWARM_LEASE_MS; job.attempts++; job.updatedAt = now
      const task = draft.state.tasks.find(item => item.id === job.taskId)
      if (task && (!task.executionId || task.executionId === job.id)) { task.status = 'running'; task.executionId = job.id; task.updatedAt = now }
    })
    return saved.jobs.find(job => job.leaseToken === token && job.status === 'running') || null
  }

  /** All completion/checkpoint writes must use this fence, including linked
   * messages/tasks. Cancellation or lease expiry wins over late model output. */
  async mutateLeased(owner: string, jobId: string, token: string, mutation: SwarmMutation): Promise<SwarmSnapshot | null> {
    let accepted = false
    const snapshot = await this.mutateInternal(owner, draft => {
      accepted = false
      const job = draft.jobs.find(item => item.id === jobId)
      if (!job || job.status !== 'running' || job.leaseToken !== token || (job.leaseUntil || 0) <= Date.now()) return
      accepted = true
      return mutation(draft)
    }, { jobId, token })
    return accepted ? snapshot : null
  }

  async renew(owner: string, jobId: string, token: string): Promise<boolean> {
    return !!await this.mutateLeased(owner, jobId, token, draft => {
      const job = draft.jobs.find(item => item.id === jobId)!
      job.leaseUntil = Date.now() + SWARM_LEASE_MS; job.updatedAt = Date.now()
    })
  }
}

export default SwarmStore
