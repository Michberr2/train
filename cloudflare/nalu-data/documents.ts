import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_PARTS, DOCUMENT_PART_BYTES, validDataId, validDigest, type DataDatabase, type WireDocument } from './protocol'

const encoder = new TextEncoder()
const reply = (body: unknown, status = 200) => ({ body, status })
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')

export async function documentOperation(db: DataDatabase, operation: string, data: any) {
  if (operation === 'collect') {
    // Only unreachable upload/replacement pieces are eligible. Retiring or
    // reading a manifest refreshes its parts for seven days so in-flight
    // readers can finish even after a new revision replaces that manifest.
    const result = await db.prepare(`DELETE FROM nalu_document_parts WHERE (owner,sha256) IN (
      SELECT p.owner,p.sha256 FROM nalu_document_parts p WHERE julianday(p.touched_at)<julianday('now','-7 days')
        AND NOT EXISTS(SELECT 1 FROM nalu_document_manifests m,json_each(m.parts) h WHERE m.owner=p.owner AND h.value=p.sha256)
      ORDER BY p.touched_at LIMIT 100) RETURNING sha256`).all()
    return reply({ ok: true, removed: result.results.length })
  }
  if (!validDataId(data.owner)) return reply({ error: 'Invalid document owner.' }, 400)
  if (operation === 'parts/put') {
    if (!validDigest(data.sha256) || typeof data.base64 !== 'string' || data.base64.length > Math.ceil(DOCUMENT_PART_BYTES / 3) * 4 || data.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(data.base64)) return reply({ error: 'Invalid document part.' }, 400)
    let binary: string
    try { binary = atob(data.base64) } catch { return reply({ error: 'Invalid document part.' }, 400) }
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    if (!bytes.length || bytes.length > DOCUMENT_PART_BYTES || hex(await crypto.subtle.digest('SHA-256', bytes)) !== data.sha256) return reply({ error: 'Document part failed its integrity check.' }, 400)
    await db.prepare("INSERT INTO nalu_document_parts(owner,sha256,base64,byte_length,touched_at) VALUES(?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(owner,sha256) DO UPDATE SET touched_at=excluded.touched_at").bind(data.owner, data.sha256, data.base64, bytes.length).all()
    return reply({ ok: true })
  }
  if (operation === 'parts/read' || operation === 'parts/check') {
    const max = operation === 'parts/read' ? 2 : 90
    if (!Array.isArray(data.hashes) || !data.hashes.length || data.hashes.length > max || !data.hashes.every(validDigest)) return reply({ error: 'Invalid document parts.' }, 400)
    const columns = operation === 'parts/read' ? 'sha256,base64,byte_length' : 'sha256'
    const result = await db.prepare(`UPDATE nalu_document_parts SET touched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner=? AND sha256 IN (${data.hashes.map(() => '?').join(',')}) RETURNING ${columns}`).bind(data.owner, ...data.hashes).all()
    return reply({ parts: result.results })
  }
  if (operation === 'read') {
    if (!Array.isArray(data.keys) || data.keys.length > 20 || !data.keys.every(validDataId)) return reply({ error: 'Invalid document selection.' }, 400)
    const statements = [db.prepare('SELECT revision FROM nalu_store_revisions WHERE scope=?').bind(`user:${data.owner}`)]
    if (data.keys.length) statements.push(db.prepare(`SELECT d.key,d.value,d.updated_at,m.parts,m.sha256,m.byte_length FROM nalu_user_data d
      LEFT JOIN nalu_document_manifests m ON m.owner=d.user_id AND m.key=d.key
      WHERE d.user_id=? AND d.key IN (${data.keys.map(() => '?').join(',')})`).bind(data.owner, ...data.keys))
    if (data.keys.length) statements.push(db.prepare(`UPDATE nalu_document_parts SET touched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE owner=? AND sha256 IN (SELECT h.value FROM nalu_document_manifests m,json_each(m.parts) h WHERE m.owner=? AND m.key IN (${data.keys.map(() => '?').join(',')}))`).bind(data.owner,data.owner,...data.keys))
    const result = await db.batch(statements)
    const entries = (result[1]?.results || []).map(row => row.parts === null ? { key: row.key, value: row.value, updated_at: row.updated_at } : {
      key: row.key, updated_at: row.updated_at, manifest: { parts: JSON.parse(String(row.parts)), sha256: row.sha256, byteLength: row.byte_length },
    })
    return reply({ revision: result[0].results[0]?.revision || '', entries })
  }
  if (operation !== 'commit') return reply({ error: 'Unknown document operation.' }, 404)
  if (typeof data.revision !== 'string' || data.revision.length > 64 || !Array.isArray(data.entries) || !data.entries.length || data.entries.length > 20) return reply({ error: 'Invalid document update.' }, 400)
  const seen = new Set<string>(), manifests = []; let totalBytes = 0
  for (const item of data.entries as WireDocument[]) {
    if (!item || !validDataId(item.key) || seen.has(item.key)) return reply({ error: 'Invalid document key.' }, 400)
    seen.add(item.key)
    if (item.manifest) {
      const manifest = item.manifest
      if (item.value !== undefined || !validDigest(manifest.sha256) || !Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > DOCUMENT_MAX_PARTS || !manifest.parts.every(validDigest) || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength <= 0 || manifest.byteLength > DOCUMENT_MAX_BYTES) return reply({ error: 'Invalid document manifest.' }, 400)
      manifests.push(manifest); totalBytes += manifest.byteLength
    } else {
      if (typeof item.value !== 'string' || encoder.encode(item.value).length > 1000000) return reply({ error: 'Split large document values before saving.' }, 400)
      try { JSON.parse(item.value) } catch { return reply({ error: 'Document value must be JSON.' }, 400) }
      totalBytes += encoder.encode(item.value).length
    }
  }
  if (totalBytes > DOCUMENT_MAX_BYTES) return reply({ error: 'The document update exceeds the supported save size.' }, 413)
  if (data.lease && (!validDataId(data.lease.flowId) || !validDataId(data.lease.token))) return reply({ error: 'Invalid flow lease.' }, 400)
  if (data.stopTaskId !== undefined && !validDataId(data.stopTaskId)) return reply({ error: 'Invalid stopped task.' }, 400)
  const leaseGuard = data.lease ? " AND EXISTS(SELECT 1 FROM nalu_flow_leases WHERE user_id=? AND flow_id=? AND token=? AND julianday(expires_at)>julianday('now'))" : ''
  const leaseParams = data.lease ? [data.owner, data.lease.flowId, data.lease.token] : []
  const scope = `user:${data.owner}`, revision = crypto.randomUUID(), now = new Date().toISOString()
  // Sum joined rows (including repeated hashes), and independently reject any
  // missing part. This check and revision publication are in one D1 transaction.
  const complete = `NOT EXISTS(SELECT 1 FROM json_each(?) m WHERE
    (SELECT COALESCE(SUM(p.byte_length),0) FROM json_each(m.value,'$.parts') h JOIN nalu_document_parts p ON p.owner=? AND p.sha256=h.value) != json_extract(m.value,'$.byteLength')
    OR EXISTS(SELECT 1 FROM json_each(m.value,'$.parts') h WHERE NOT EXISTS(SELECT 1 FROM nalu_document_parts p WHERE p.owner=? AND p.sha256=h.value)))`
  const encodedManifests = JSON.stringify(manifests), completenessParams = [encodedManifests, data.owner, data.owner]
  const statements = [
    db.prepare("INSERT INTO nalu_store_revisions(scope,revision) VALUES(?,'') ON CONFLICT DO NOTHING").bind(scope),
    db.prepare(`SELECT ${complete} AS complete`).bind(...completenessParams),
    db.prepare(`UPDATE nalu_store_revisions SET revision=? WHERE scope=? AND revision=? AND ${complete}${leaseGuard} RETURNING revision`).bind(revision, scope, data.revision, ...completenessParams, ...leaseParams),
  ]
  statements.push(db.prepare(`UPDATE nalu_document_parts SET touched_at=? WHERE owner=?
    AND sha256 IN (SELECT h.value FROM nalu_document_manifests m,json_each(m.parts) h WHERE m.owner=? AND m.key IN (SELECT value FROM json_each(?)))
    AND EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=? AND revision=?)`).bind(now,data.owner,data.owner,JSON.stringify([...seen]),scope,revision))
  for (const item of data.entries as WireDocument[]) {
    statements.push(db.prepare(`INSERT INTO nalu_user_data(user_id,key,value,updated_at) SELECT ?,?,?,?
      WHERE EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=? AND revision=?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(data.owner, item.key, item.manifest ? null : item.value, now, scope, revision))
    if (item.manifest) statements.push(db.prepare(`INSERT INTO nalu_document_manifests(owner,key,parts,sha256,byte_length) SELECT ?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=? AND revision=?)
      ON CONFLICT(owner,key) DO UPDATE SET parts=excluded.parts,sha256=excluded.sha256,byte_length=excluded.byte_length`).bind(data.owner, item.key, JSON.stringify(item.manifest.parts), item.manifest.sha256, item.manifest.byteLength, scope, revision))
    else statements.push(db.prepare('DELETE FROM nalu_document_manifests WHERE owner=? AND key=? AND EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=? AND revision=?)').bind(data.owner, item.key, scope, revision))
  }
  if (data.stopTaskId) statements.push(db.prepare(`UPDATE nalu_tasks SET status='cancelled',detail='Stopped',
    events=json_insert(events,'$[#]',json_object('t',?,'m','Stopped')),updated_at=?
    WHERE user_id=? AND id=? AND status IN ('queued','running','waiting')
      AND EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=? AND revision=?)`).bind(now,now,data.owner,data.stopTaskId,scope,revision))
  const result = await db.batch(statements)
  if (!result[1].results[0]?.complete) return reply({ error: 'The document upload is incomplete. Existing data was retained.' }, 400)
  return result[2].results.length ? reply({ ok: true, revision }) : reply({ error: 'Document changed. Read and merge again.', conflict: true }, 409)
}
