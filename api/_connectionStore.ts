import { randomUUID } from 'node:crypto'
import { CloudflareStore, type CloudflareStatement } from './_cloudflareStore'
import type { ArtifactClient } from './_autopilotArtifacts'
import type { ConnectionRow } from './_connectionRuntime'
import type { DeliveryResult } from './_pipelineDelivery'

export type ConnectionClient = ArtifactClient | CloudflareStore
type Row = Record<string, any>
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const paramsForD1 = (values: unknown[]): CloudflareStatement['params'] => values.map(value => value == null ? null : typeof value === 'object' ? JSON.stringify(value) : value as string | number)

/** Each operation has reviewed SQL for each database. This deliberately does
 * not translate arbitrary PostgreSQL, discard locks, or emulate transactions. */
export class ConnectionStore {
  constructor(readonly client: ConnectionClient) {}
  get cloudflare(): CloudflareStore | null { return this.client instanceof CloudflareStore ? this.client : null }
  private async run(postgres: string, sqlite: string, params: unknown[], write = false, jsonFields: string[] = []): Promise<Row[]> {
    const d1 = this.cloudflare
    if (!d1) return (await (this.client as ArtifactClient).query(postgres, params)).rows
    const values = paramsForD1(params)
    const rows = write ? (await d1.batch([{ sql: sqlite, params: values }])).results[0].results : (await d1.query(sqlite, values)).results
    return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonFields.includes(key) && typeof value === 'string' ? JSON.parse(value) : value])))
  }
  async get(userId: string, id: string): Promise<ConnectionRow | undefined> {
    return (await this.run('SELECT * FROM nalu_connections WHERE user_id=$1 AND id=$2', 'SELECT * FROM nalu_connections WHERE user_id=?1 AND id=?2', [userId, id], false, ['meta']))[0] as ConnectionRow | undefined
  }
  async list(userId: string): Promise<Row[]> {
    return this.run('SELECT * FROM nalu_connections WHERE user_id = $1 ORDER BY created_at DESC', 'SELECT * FROM nalu_connections WHERE user_id=?1 ORDER BY created_at DESC', [userId], false, ['meta'])
  }
  async forApp(userId: string, app: string): Promise<ConnectionRow[]> {
    return this.run('SELECT * FROM nalu_connections WHERE user_id=$1 AND app=$2 ORDER BY created_at ASC', 'SELECT * FROM nalu_connections WHERE user_id=?1 AND app=?2 ORDER BY created_at ASC', [userId, app], false, ['meta']) as Promise<ConnectionRow[]>
  }
  async emailAccount(userId: string, summary = false): Promise<Row | undefined> {
    const columns = summary ? 'app,username' : '*'
    return (await this.run(`SELECT ${columns} FROM nalu_connections WHERE user_id=$1 AND app IN ('gmail','outlook') AND status='connected' AND enc_secret IS NOT NULL ORDER BY created_at ASC LIMIT 1`, `SELECT ${columns} FROM nalu_connections WHERE user_id=?1 AND app IN ('gmail','outlook') AND status='connected' AND enc_secret IS NOT NULL ORDER BY created_at ASC LIMIT 1`, [userId], false, ['meta']))[0]
  }
  async ingestAccount(token: string): Promise<Row | undefined> {
    return (await this.run('SELECT id, user_id FROM nalu_connections WHERE ingest_token = $1', 'SELECT id,user_id FROM nalu_connections WHERE ingest_token=?1', [token]))[0]
  }
  async ingest(id: string, connectionId: string, userId: string, sender: string, subject: string, body: string, meta: Record<string, unknown>): Promise<void> {
    await this.run('INSERT INTO nalu_inbound (id, conn_id, user_id, sender, subject, body, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)', 'INSERT INTO nalu_inbound(id,conn_id,user_id,sender,subject,body,meta) VALUES(?1,?2,?3,?4,?5,?6,?7)', [id, connectionId, userId, sender, subject, body, meta], true)
  }
  async inbox(userId: string, id: string | undefined, limit: number): Promise<Row[]> {
    return id ? this.run('SELECT * FROM nalu_inbound WHERE user_id=$1 AND conn_id=$2 ORDER BY received_at DESC LIMIT $3', 'SELECT * FROM nalu_inbound WHERE user_id=?1 AND conn_id=?2 ORDER BY received_at DESC LIMIT ?3', [userId, id, limit], false, ['meta'])
      : this.run('SELECT * FROM nalu_inbound WHERE user_id=$1 ORDER BY received_at DESC LIMIT $2', 'SELECT * FROM nalu_inbound WHERE user_id=?1 ORDER BY received_at DESC LIMIT ?2', [userId, limit], false, ['meta'])
  }
  async remove(userId: string, id: string): Promise<void> {
    await this.run('DELETE FROM nalu_connections WHERE user_id=$1 AND id=$2', 'DELETE FROM nalu_connections WHERE user_id=?1 AND id=?2', [userId, id], true)
  }
  async saveManual(values: unknown[], prior?: ConnectionRow): Promise<void> {
    const rows = await this.run(`INSERT INTO nalu_connections (id, user_id, app, label, method, username, endpoint, enc_secret, status, meta, ingest_token, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,NOW())
         ON CONFLICT (user_id, id) DO UPDATE SET
           app=$3, label=$4, method=$5, username=COALESCE($6, nalu_connections.username),
           endpoint=$7,
           enc_secret=$8,
           status='pending', meta=$9,
           ingest_token=COALESCE(nalu_connections.ingest_token, $10), updated_at=NOW()`,
      `INSERT INTO nalu_connections(id,user_id,app,label,method,username,endpoint,enc_secret,status,meta,ingest_token,updated_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending',?9,?10,${now})
       ON CONFLICT(user_id,id) DO UPDATE SET app=?3,label=?4,method=?5,username=COALESCE(?6,nalu_connections.username),
       endpoint=?7,enc_secret=?8,status='pending',meta=?9,ingest_token=COALESCE(nalu_connections.ingest_token,?10),updated_at=${now}
       WHERE ?11=1 AND nalu_connections.app=?3 AND nalu_connections.enc_secret IS ?12 AND nalu_connections.method=?13 RETURNING id`,
      this.cloudflare ? [...values, Number(!!prior), prior?.enc_secret || null, prior?.method || null] : values, true)
    if (this.cloudflare && !rows.length) throw new Error('This connection changed while it was being edited. Open it again before saving.')
  }
  async reviews(userId: string): Promise<Row[]> {
    return this.run(`SELECT r.delivery_key,r.connection_id,r.created_at,r.result,r.payload->>'filename' AS filename,c.label
          FROM nalu_connection_reviews r JOIN nalu_connections c ON c.user_id=r.user_id AND c.id=r.connection_id
          WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT 50`,
      `SELECT r.delivery_key,r.connection_id,r.created_at,COALESCE(d.result,r.result) AS result,json_extract(r.payload,'$.filename') AS filename,c.label
       FROM nalu_connection_reviews r JOIN nalu_connections c ON c.user_id=r.user_id AND c.id=r.connection_id
       LEFT JOIN nalu_pipeline_deliveries d ON d.user_id=r.user_id AND d.delivery_key=r.delivery_key
       WHERE r.user_id=?1 ORDER BY r.created_at DESC LIMIT 50`, [userId], false, ['result'])
  }
  async launchOAuth(id: string, userId: string, provider: string, returnTo: string, verifier: string, connectionId?: string): Promise<void> {
    await this.run('INSERT INTO nalu_oauth_states(id,user_id,provider,return_to,code_verifier,connection_id) VALUES($1,$2,$3,$4,$5,$6)', 'INSERT INTO nalu_oauth_states(id,user_id,provider,return_to,code_verifier,connection_id) VALUES(?1,?2,?3,?4,?5,?6)', [id, userId, provider, returnTo, verifier, connectionId || null], true)
  }
  async consumeOAuth(id: string): Promise<Row | undefined> {
    return (await this.run("DELETE FROM nalu_oauth_states WHERE id=$1 AND phase='consent' AND expires_at>NOW() RETURNING user_id,provider,return_to,code_verifier,connection_id", "DELETE FROM nalu_oauth_states WHERE id=?1 AND phase='consent' AND julianday(expires_at)>julianday('now') RETURNING user_id,provider,return_to,code_verifier,connection_id", [id], true))[0]
  }
  async startOAuth(id: string): Promise<Row | undefined> {
    return (await this.run("UPDATE nalu_oauth_states SET phase='consent' WHERE id=$1 AND phase='launch' AND expires_at>NOW() RETURNING provider,code_verifier", "UPDATE nalu_oauth_states SET phase='consent' WHERE id=?1 AND phase='launch' AND julianday(expires_at)>julianday('now') RETURNING provider,code_verifier", [id], true))[0]
  }
  async saveOAuth(values: unknown[]): Promise<void> {
    await this.run(`INSERT INTO nalu_connections(id,user_id,app,label,method,username,status,meta,ingest_token,enc_secret,updated_at)
        VALUES($1,$2,$3,$4,'oauth',$5,$6,$7::jsonb,$8,$9,NOW())
        ON CONFLICT(user_id,id) DO UPDATE SET app=EXCLUDED.app,method='oauth',username=EXCLUDED.username,endpoint=NULL,enc_secret=EXCLUDED.enc_secret,status=EXCLUDED.status,meta=EXCLUDED.meta,updated_at=NOW()`,
      `INSERT INTO nalu_connections(id,user_id,app,label,method,username,status,meta,ingest_token,enc_secret,updated_at)
       VALUES(?1,?2,?3,?4,'oauth',?5,?6,?7,?8,?9,${now})
       ON CONFLICT(user_id,id) DO UPDATE SET app=excluded.app,method='oauth',username=excluded.username,endpoint=NULL,
       enc_secret=excluded.enc_secret,status=excluded.status,meta=excluded.meta,updated_at=${now}`, values, true)
  }
  async verified(userId: string, row: ConnectionRow, status: string): Promise<void> {
    const values = [userId, row.id, row.username, status, JSON.stringify(row.meta || {})]
    const saved = await this.run('UPDATE nalu_connections SET username=$3,status=$4,meta=$5::jsonb,updated_at=NOW() WHERE user_id=$1 AND id=$2', `UPDATE nalu_connections SET username=?3,status=?4,meta=?5,updated_at=${now} WHERE user_id=?1 AND id=?2 AND enc_secret IS ?6 AND method=?7 RETURNING id`, this.cloudflare ? [...values, row.enc_secret || null, row.method] : values, true)
    if (this.cloudflare && !saved.length) throw new Error('This connection changed while it was being checked. Open it again to verify the current account.')
  }
  async verificationStatus(userId: string, id: string, status: string, meta: Record<string, unknown>, expected?: ConnectionRow): Promise<void> {
    // These patches contain concrete detail/verifiedAt values, not JSON nulls;
    // json_patch therefore preserves the PostgreSQL shallow-merge behavior.
    const values = [userId, id, status, JSON.stringify(meta)]
    await this.run('UPDATE nalu_connections SET status=$3,meta=meta||$4::jsonb,updated_at=NOW() WHERE user_id=$1 AND id=$2', `UPDATE nalu_connections SET status=?3,meta=json_patch(meta,?4),updated_at=${now} WHERE user_id=?1 AND id=?2${expected ? ' AND enc_secret IS ?5 AND method=?6' : ''}`, this.cloudflare && expected ? [...values, expected.enc_secret || null, expected.method] : values, true)
  }
  async delivery(userId: string, key: string): Promise<{ result: DeliveryResult | null; revision?: string } | undefined> {
    return (await this.run('SELECT result FROM nalu_pipeline_deliveries WHERE user_id=$1 AND delivery_key=$2', 'SELECT result,revision FROM nalu_pipeline_deliveries WHERE user_id=?1 AND delivery_key=?2', [userId, key], false, ['result']))[0] as { result: DeliveryResult | null; revision?: string } | undefined
  }
  async claimDelivery(userId: string, key: string): Promise<boolean> {
    const rows = await this.run('INSERT INTO nalu_pipeline_deliveries (user_id, delivery_key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING delivery_key', 'INSERT INTO nalu_pipeline_deliveries (user_id,delivery_key) VALUES (?1,?2) ON CONFLICT DO NOTHING RETURNING delivery_key', [userId, key], true)
    return rows.length > 0
  }
  async completeDelivery(userId: string, key: string, result: DeliveryResult): Promise<void> {
    await this.run('UPDATE nalu_pipeline_deliveries SET result=$3::jsonb WHERE user_id=$1 AND delivery_key=$2', 'UPDATE nalu_pipeline_deliveries SET result=?3,revision=?4 WHERE user_id=?1 AND delivery_key=?2', this.cloudflare ? [userId, key, JSON.stringify(result), randomUUID()] : [userId, key, JSON.stringify(result)], true)
  }
  async queueReview(userId: string, key: string, connectionId: string, accountId: string, payload: Record<string, unknown>): Promise<Row | undefined> {
    await this.run('INSERT INTO nalu_connection_reviews(user_id,delivery_key,connection_id,account_id,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING', 'INSERT INTO nalu_connection_reviews(user_id,delivery_key,connection_id,account_id,payload) VALUES(?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING', [userId, key, connectionId, accountId, JSON.stringify(payload)], true)
    return this.review(userId, key)
  }
  async review(userId: string, key: string): Promise<Row | undefined> {
    return (await this.run('SELECT * FROM nalu_connection_reviews WHERE user_id=$1 AND delivery_key=$2', 'SELECT * FROM nalu_connection_reviews WHERE user_id=?1 AND delivery_key=?2', [userId, key], false, ['payload', 'result']))[0]
  }
  async completeReview(userId: string, key: string, result: DeliveryResult, checked = false): Promise<void> {
    await this.run(`UPDATE nalu_connection_reviews SET result=$3::jsonb${checked ? ',checked_at=NOW()' : ''} WHERE user_id=$1 AND delivery_key=$2`, `UPDATE nalu_connection_reviews SET result=COALESCE((SELECT result FROM nalu_pipeline_deliveries WHERE user_id=?1 AND delivery_key=?2),?3)${checked ? `,checked_at=${now}` : ''} WHERE user_id=?1 AND delivery_key=?2`, [userId, key, JSON.stringify(result)], true)
  }
  async pendingPosts(): Promise<Row[]> {
    return this.run(`SELECT r.user_id,r.delivery_key,r.account_id,r.connection_id FROM nalu_connection_reviews r
      LEFT JOIN nalu_pipeline_deliveries d ON d.user_id=r.user_id AND d.delivery_key=r.delivery_key
      WHERE COALESCE(d.result,r.result)->>'status'='accepted' AND COALESCE(d.result,r.result)->>'ok'='true' ORDER BY r.checked_at ASC NULLS FIRST,r.created_at ASC LIMIT 3`,
      `SELECT r.user_id,r.delivery_key,r.account_id,r.connection_id FROM nalu_connection_reviews r
      LEFT JOIN nalu_pipeline_deliveries d ON d.user_id=r.user_id AND d.delivery_key=r.delivery_key
      WHERE json_extract(COALESCE(d.result,r.result),'$.status')='accepted' AND json_extract(COALESCE(d.result,r.result),'$.ok')=1 ORDER BY r.checked_at ASC,r.created_at ASC LIMIT 3`, [])
  }
  async checkedPost(userId: string, key: string): Promise<void> {
    await this.run('UPDATE nalu_connection_reviews SET checked_at=NOW() WHERE user_id=$1 AND delivery_key=$2', `UPDATE nalu_connection_reviews SET checked_at=${now} WHERE user_id=?1 AND delivery_key=?2`, [userId, key], true)
  }
  /** Status polling is optimistic on D1. A stale provider response cannot
   * replace a newer receipt; the progress card updates in the same batch. */
  async progress(userId: string, key: string, revision: string, result: DeliveryResult): Promise<boolean> {
    const d1 = this.cloudflare
    if (!d1) throw new Error('Atomic progress revisions require Cloudflare storage.')
    const next = randomUUID(), encoded = JSON.stringify(result)
    const saved = await d1.batch([
      { sql: 'UPDATE nalu_pipeline_deliveries SET result=?3,revision=?4 WHERE user_id=?1 AND delivery_key=?2 AND revision=?5 RETURNING delivery_key', params: [userId, key, encoded, next, revision] },
      { sql: `UPDATE nalu_connection_reviews SET result=?3,checked_at=${now} WHERE user_id=?1 AND delivery_key=?2 AND EXISTS(SELECT 1 FROM nalu_pipeline_deliveries WHERE user_id=?1 AND delivery_key=?2 AND revision=?4)`, params: [userId, key, encoded, next] },
    ])
    return saved.results[0].results.length > 0
  }
  async claimRefresh(userId: string, id: string, original: string, source: string, claim: string): Promise<boolean> {
    const d1 = this.cloudflare
    if (!d1) throw new Error('Durable refresh claims require Cloudflare storage.')
    const result = await d1.batch([{ sql: `INSERT INTO nalu_connection_refreshes(user_id,connection_id,source_sha256,claim_token,state)
      SELECT ?1,?2,?3,?4,'pending' FROM nalu_connections WHERE user_id=?1 AND id=?2 AND method='oauth' AND enc_secret=?5
      ON CONFLICT(user_id,connection_id,source_sha256) DO NOTHING RETURNING claim_token`, params: [userId, id, source, claim, original] }])
    return result.results[0].results.length > 0
  }
  async refreshState(userId: string, id: string, source: string): Promise<Row | undefined> {
    if (!this.cloudflare) throw new Error('Durable refresh claims require Cloudflare storage.')
    return (await this.cloudflare.query('SELECT state,created_at FROM nalu_connection_refreshes WHERE user_id=?1 AND connection_id=?2 AND source_sha256=?3', [userId, id, source])).results[0]
  }
  async finishRefresh(userId: string, id: string, source: string, claim: string, original: string, encrypted: string): Promise<boolean> {
    const d1 = this.cloudflare
    if (!d1) throw new Error('Durable refresh claims require Cloudflare storage.')
    const params = [userId, id, source, claim, original, encrypted]
    const result = await d1.batch([
      { sql: `UPDATE nalu_connections SET enc_secret=?6,updated_at=${now} WHERE user_id=?1 AND id=?2 AND enc_secret=?5 AND method='oauth'
        AND EXISTS(SELECT 1 FROM nalu_connection_refreshes WHERE user_id=?1 AND connection_id=?2 AND source_sha256=?3 AND claim_token=?4 AND state='pending') RETURNING id`, params },
      { sql: `UPDATE nalu_connection_refreshes SET state='saved' WHERE user_id=?1 AND connection_id=?2 AND source_sha256=?3 AND claim_token=?4
        AND EXISTS(SELECT 1 FROM nalu_connections WHERE user_id=?1 AND id=?2 AND enc_secret=?5)`, params: [userId, id, source, claim, encrypted] },
    ])
    return result.results[0].results.length > 0
  }
  async failRefresh(userId: string, id: string, source: string, claim: string): Promise<void> {
    if (!this.cloudflare) throw new Error('Durable refresh claims require Cloudflare storage.')
    await this.cloudflare.batch([{ sql: "UPDATE nalu_connection_refreshes SET state='failed' WHERE user_id=?1 AND connection_id=?2 AND source_sha256=?3 AND claim_token=?4 AND state='pending'", params: [userId, id, source, claim] }])
  }
}
