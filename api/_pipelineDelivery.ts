import { ConnectionStore, type ConnectionClient } from './_connectionStore'

export type DeliveryResult = { ok: boolean; detail: string; receipt?: string; status?: 'accepted' | 'published'; reviewRequired?: boolean }
const uncertain = { ok: false, detail: 'Delivery is unconfirmed. Check your sent mail or publisher before starting a new run; Resume will not send a duplicate.' }

/** Claim before contacting an external app. A lost response or worker crash
 * must not turn an automatic takeover/resume into a second email or post. */
async function ensureDeliverySchema(client: ConnectionClient) {
  if (new ConnectionStore(client).cloudflare) return
  const postgres = client as import('./_autopilotArtifacts').ArtifactClient
  await postgres.query(`CREATE TABLE IF NOT EXISTS nalu_pipeline_deliveries (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    delivery_key TEXT NOT NULL, result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, delivery_key)
  )`)
}
export async function readPipelineDelivery(client: ConnectionClient, userId: string, key: string): Promise<DeliveryResult | null> {
  await ensureDeliverySchema(client)
  const prior = await new ConnectionStore(client).delivery(userId, key)
  return prior ? prior.result || uncertain : null
}
export async function deliverPipelineOnce(client: ConnectionClient, userId: string, key: string, send: () => Promise<DeliveryResult>): Promise<DeliveryResult> {
  if (!key || key.length > 400) throw new Error('Invalid pipeline delivery ID.')
  await ensureDeliverySchema(client)
  const store = new ConnectionStore(client)
  const claim = await store.claimDelivery(userId, key)
  if (!claim) {
    const prior = await store.delivery(userId, key)
    return prior?.result || uncertain
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let result: DeliveryResult
  try {
    result = await Promise.race([send(), new Promise<DeliveryResult>(resolve => { timer = setTimeout(() => resolve(uncertain), 50000) })])
  } catch { result = uncertain }
  finally { if (timer) clearTimeout(timer) }
  await store.completeDelivery(userId, key, result)
  return result
}
