import type { ArtifactClient } from './_autopilotArtifacts'
import { createHash } from 'node:crypto'
import { ensureConnectionReviews } from './_connectionReviews'
import { deliverPipelineOnce, readPipelineDelivery, type DeliveryResult } from './_pipelineDelivery'
import { withProvider, type ConnectionRow } from './_connectionRuntime'
import { instagramProcessingStatus, publishInstagramContainer, tiktokPostStatus } from './_connectionAdapters'
import { ConnectionStore, type ConnectionClient } from './_connectionStore'

export async function refreshConnectionPost(c: ConnectionClient, userId: string, row: ConnectionRow, key: string): Promise<DeliveryResult | null> {
  // Browser polling and cron can check the same receipt simultaneously. Serialize
  // those updates so an older "processing" response cannot overwrite publication.
  const lock = `connection-post:${JSON.stringify([userId, key])}`
  const store = new ConnectionStore(c), postgres = c as ArtifactClient
  const acquired = store.cloudflare || (await postgres.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lock])).rows[0]?.acquired
  if (!acquired) return readPipelineDelivery(c, userId, key)
  try {
  const snapshot = store.cloudflare ? await store.delivery(userId, key) : undefined
  const prior = snapshot?.result || await readPipelineDelivery(c, userId, key)
  if (!prior?.receipt || prior.status === 'published' || !prior.ok) return prior
  let delivery = prior
  if (row.app === 'instagram') {
    const status = await withProvider(c, userId, row, ctx => instagramProcessingStatus(ctx, prior.receipt!))
    if (status === 'FINISHED') {
      const publishKey = `media-publish:${createHash('sha256').update(key).digest('hex')}`
      delivery = await deliverPipelineOnce(c, userId, publishKey, () => withProvider(c, userId, row, ctx => publishInstagramContainer(ctx, prior.receipt!)))
      // Another poll may own the final publish, or its response may have been
      // lost. Keep the accepted container discoverable for status checks. An
      // uncertain claim is not evidence that Instagram rejected the post.
      if (!delivery.ok) return { ...prior, detail: 'Instagram publication is not yet confirmed. Nalu will check this media again without sending another post.' }
    }
    else if (status === 'PUBLISHED') delivery = { ...prior, ok: true, status: 'published', detail: 'Published to Instagram' }
    else if (['ERROR', 'EXPIRED'].includes(status)) delivery = { ...prior, ok: false, detail: 'Instagram could not process this media. The draft is saved.' }
  } else if (row.app === 'tiktok') {
    const progress = await withProvider(c, userId, row, ctx => tiktokPostStatus(ctx, prior.receipt!))
    if (progress.status === 'PUBLISH_COMPLETE') delivery = { ...prior, ok: true, status: 'published', detail: 'Published to TikTok' }
    else if (progress.status === 'FAILED') delivery = { ...prior, ok: false, detail: `TikTok could not publish this video (${String(progress.fail_reason || 'processing failed').slice(0, 100)}). The draft is saved.` }
    else delivery = { ...prior, detail: 'TikTok is still processing the video.' }
  }
  if (store.cloudflare) {
    if (!await store.progress(userId, key, snapshot?.revision || '', delivery)) {
      const current = await store.delivery(userId, key)
      // A concurrent processing check can advance the revision while the
      // provider confirms publication. Preserve that confirmed result without
      // repeating the provider operation or replacing an existing final result.
      if (delivery.status === 'published' && current?.result?.ok && current.result.status === 'accepted') {
        if (await store.progress(userId, key, current.revision || '', delivery)) return delivery
      }
      return readPipelineDelivery(c, userId, key)
    }
  } else {
    await store.completeDelivery(userId, key, delivery)
    await store.completeReview(userId, key, delivery, true)
  }
  return delivery
  } finally { if (!store.cloudflare) await postgres.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]) }
}

/** Complete already-authorized media posts while the workspace is closed. */
export async function processConnectionPosts(c: ConnectionClient): Promise<void> {
  await ensureConnectionReviews(c)
  const store = new ConnectionStore(c), pending = await store.pendingPosts()
  for (const item of pending) {
    try {
      const row = await store.get(item.user_id, item.connection_id)
      if (row && row.meta?.accountId === item.account_id) await refreshConnectionPost(c, item.user_id, row, item.delivery_key)
    } catch { /* Preserve the receipt on temporary provider failures. */ }
    await store.checkedPost(item.user_id, item.delivery_key)
  }
}
