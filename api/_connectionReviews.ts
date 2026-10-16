import { ConnectionStore, type ConnectionClient } from './_connectionStore'
import type { DeliveryResult } from './_pipelineDelivery'

export async function ensureConnectionReviews(c: ConnectionClient) {
  if (new ConnectionStore(c).cloudflare) return
  await (c as import('./_autopilotArtifacts').ArtifactClient).query(`CREATE TABLE IF NOT EXISTS nalu_connection_reviews (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, delivery_key TEXT NOT NULL,
    connection_id TEXT NOT NULL, account_id TEXT NOT NULL, payload JSONB NOT NULL, result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checked_at TIMESTAMPTZ, PRIMARY KEY(user_id,delivery_key));
    ALTER TABLE nalu_connection_reviews ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ`)
}
export async function queueConnectionReview(c: ConnectionClient, userId: string, key: string, connectionId: string, accountId: string, payload: Record<string, unknown>): Promise<DeliveryResult> {
  if (!key || key.length > 400) throw new Error('Invalid delivery ID.')
  if (JSON.stringify(payload).length > 1000000) throw new Error('This post is too large to save for review.')
  await ensureConnectionReviews(c)
  const saved = await new ConnectionStore(c).queueReview(userId, key, connectionId, accountId, payload)
  if (saved?.result) return saved.result
  return { ok: false, reviewRequired: true, detail: 'Video saved. Open Connections to review this TikTok post, then resume the pipeline.' }
}
