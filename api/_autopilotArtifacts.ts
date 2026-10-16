import { createHash } from 'node:crypto'
import type { OutputKind } from '../shared/autopilotFiles'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareAttachments } from './_cloudflareAttachments'
import { storeAttachment } from './_taskAttachments'

export type ArtifactClient = { query: (q: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }> }
export type ArtifactStore = ArtifactClient | CloudflareStore
export type ArtifactMeta = {
  id: string; flowId: string; flowName: string; nodeId: string; nodeLabel: string
  runId: string; kind: OutputKind; filename: string; size: number; ts: number; storage: 'server'; mime?: string
}
export const MAX_ARTIFACT_BYTES = 1024 * 1024
const schemaClients = new WeakSet<ArtifactClient>()

/** Bytes stay out of the synchronised localStorage/flow JSON. Account deletion
 * cascades here; ordinary flow deletion leaves its Outputs library intact. */
export async function ensureArtifactSchema(client: ArtifactStore): Promise<void> {
  if (client instanceof CloudflareStore) return
  if (schemaClients.has(client)) return
  await client.query(`CREATE TABLE IF NOT EXISTS nalu_autopilot_artifacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    meta JSONB NOT NULL,
    bytes BYTEA NOT NULL CHECK (octet_length(bytes) <= 1048576),
    result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE nalu_autopilot_artifacts ADD COLUMN IF NOT EXISTS result TEXT;
  CREATE INDEX IF NOT EXISTS nalu_autopilot_artifacts_user_created
    ON nalu_autopilot_artifacts (user_id, created_at DESC, id DESC)`)
  schemaClients.add(client)
}

export function artifactId(userId: string, runId: string, nodeId: string): string {
  return `artifact_${createHash('sha256').update(JSON.stringify([userId, runId, nodeId])).digest('hex')}`
}

export async function readArtifact(client: ArtifactStore, userId: string, id: string): Promise<{ meta: ArtifactMeta; bytes: Buffer; result: string } | null> {
  await ensureArtifactSchema(client)
  if (client instanceof CloudflareStore) {
    const row = (await client.query('SELECT meta,result,attachment_id FROM nalu_autopilot_artifacts WHERE user_id=? AND id=?', [userId, id])).results[0]
    if (!row) return null
    const files = new CloudflareAttachments(client), attachment = row.attachment_id ? await files.get(userId, String(row.attachment_id)) : null
    if (!attachment?.ready) throw new Error('Saved output is incomplete. Its original record has been preserved.')
    const parts: Buffer[] = []
    for (let part = 0; part < attachment.meta.parts; part++) {
      const bytes = await files.part(userId, attachment.meta.id, part)
      if (!bytes) throw new Error('Saved output is incomplete. Its original record has been preserved.')
      parts.push(bytes)
    }
    const bytes = Buffer.concat(parts)
    if (bytes.length !== attachment.meta.size || createHash('sha256').update(bytes).digest('hex') !== attachment.meta.sha256) throw new Error('Saved output failed its integrity check.')
    return { meta: JSON.parse(String(row.meta)), bytes, result: typeof row.result === 'string' ? row.result : bytes.toString('utf8') }
  }
  const row = (await client.query('SELECT meta, bytes, result FROM nalu_autopilot_artifacts WHERE user_id=$1 AND id=$2', [userId, id])).rows[0]
  return row ? { meta: row.meta as ArtifactMeta, bytes: Buffer.from(row.bytes), result: typeof row.result === 'string' ? row.result : Buffer.from(row.bytes).toString('utf8') } : null
}

export type BuiltArtifact = { kind: OutputKind; filename: string; mime: string; bytes: Buffer; result: string }
type ArtifactIdentity = Pick<ArtifactMeta, 'flowId' | 'flowName' | 'nodeId' | 'nodeLabel' | 'runId' | 'ts'>

/** Recover before generating: a crash after file commit must not repeat a model
 * call or replace its bytes. Metadata stays small; downstream text is separate. */
export async function storeGeneratedArtifact(client: ArtifactStore, userId: string, input: ArtifactIdentity, build: () => Promise<BuiltArtifact>): Promise<{ meta: ArtifactMeta; bytes: Buffer; result: string }> {
  const id = artifactId(userId, input.runId, input.nodeId)
  const prior = await readArtifact(client, userId, id)
  if (prior) return prior
  const generated = await build()
  if (generated.bytes.length > MAX_ARTIFACT_BYTES) throw new Error('File exceeds the 1 MB saved-output limit. Split the content into smaller files.')
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(generated.mime)) throw new Error('Invalid output content type.')
  const meta: ArtifactMeta = { ...input, id, kind: generated.kind, filename: generated.filename, mime: generated.mime, size: generated.bytes.length, storage: 'server' }
  if (client instanceof CloudflareStore) {
    const attachment = await storeAttachment(client, userId, { sourceId: id, flowId: input.flowId, taskId: input.runId, title: input.nodeLabel, filename: generated.filename, mime: generated.mime }, generated.bytes)
    await client.batch([{ sql: "INSERT INTO nalu_autopilot_artifacts(id,user_id,meta,bytes,result,attachment_id) VALUES(?,?,?,X'',?,?) ON CONFLICT(id) DO NOTHING", params: [id, userId, JSON.stringify(meta), generated.result, attachment.id] }])
  } else await client.query(`INSERT INTO nalu_autopilot_artifacts (id, user_id, meta, bytes, result)
    VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT (id) DO NOTHING`, [id, userId, JSON.stringify(meta), generated.bytes, generated.result])
  const saved = await readArtifact(client, userId, id)
  if (!saved) throw new Error('The file could not be saved. Resume to retry this step.')
  return saved
}

/** First committed file wins for this account/run/node. A crash after storing
 * bytes but before checkpointing can safely recover the original file. */
export async function storeTextArtifact(client: ArtifactStore, userId: string, input: Omit<ArtifactMeta, 'id' | 'kind' | 'size' | 'storage'>, body: string): Promise<{ meta: ArtifactMeta; body: string }> {
  const saved = await storeGeneratedArtifact(client, userId, input, async () => ({ kind: 'text', filename: input.filename, mime: 'text/plain', bytes: Buffer.from(body, 'utf8'), result: body }))
  return { meta: saved.meta, body: saved.result }
}

export async function listArtifacts(client: ArtifactStore, userId: string): Promise<ArtifactMeta[]> {
  await ensureArtifactSchema(client)
  if (client instanceof CloudflareStore) return (await client.query('SELECT meta FROM nalu_autopilot_artifacts WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 60', [userId])).results.map(row => JSON.parse(String(row.meta)))
  const rows = (await client.query('SELECT meta FROM nalu_autopilot_artifacts WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 60', [userId])).rows
  return rows.map((row) => row.meta as ArtifactMeta)
}

export async function deleteArtifact(client: ArtifactStore, userId: string, id: string): Promise<void> {
  await ensureArtifactSchema(client)
  if (client instanceof CloudflareStore) { await client.batch([{ sql: 'DELETE FROM nalu_autopilot_artifacts WHERE user_id=? AND id=?', params: [userId, id] }]); return }
  await client.query('DELETE FROM nalu_autopilot_artifacts WHERE user_id=$1 AND id=$2', [userId, id])
}
