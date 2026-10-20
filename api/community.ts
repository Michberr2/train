import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { cors } from './_cors'
import { connectionBackend, type ConnectionBackend } from './_connectionBackend'
import { readToken, safeJson } from './_db'
import { CloudflareStore } from './_cloudflareStore'

const MAX_TITLE = 80, MAX_MESSAGE = 4000, INVITE_MS = 7 * 24 * 60 * 60 * 1000
type Db = { query: (sql: string, params?: unknown[]) => Promise<any> }
const now = () => Date.now()
const id = () => randomUUID()
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const clean = (value: unknown, _max: number) => typeof value === 'string' ? value.trim() : ''
async function ensurePg(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS nalu_community_rooms(id TEXT PRIMARY KEY,title TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,created_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS nalu_community_members(room_id TEXT NOT NULL REFERENCES nalu_community_rooms(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,role TEXT NOT NULL,joined_at BIGINT NOT NULL,PRIMARY KEY(room_id,user_id));
    CREATE TABLE IF NOT EXISTS nalu_community_invites(token_hash TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES nalu_community_rooms(id) ON DELETE CASCADE,created_by TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,expires_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS nalu_community_messages(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES nalu_community_rooms(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,content TEXT NOT NULL,created_at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS nalu_community_member_user ON nalu_community_members(user_id,joined_at);
    CREATE INDEX IF NOT EXISTS nalu_community_message_room ON nalu_community_messages(room_id,created_at);`)
}
function query(db: Db, sqlite: boolean, pgSql: string, sqliteSql = pgSql.replaceAll(/\$\d+/g, (p) => `?${p.slice(1)}`), params: unknown[] = []) {
  return db.query(sqlite ? sqliteSql : pgSql, params)
}
async function member(db: Db, sqlite: boolean, roomId: string, userId: string) {
  const result = await query(db, sqlite, 'SELECT role FROM nalu_community_members WHERE room_id=$1 AND user_id=$2', undefined, [roomId, userId])
  return !!(sqlite ? result.results?.[0] : result.rows?.[0])
}
async function listRooms(db: Db, sqlite: boolean, userId: string) {
  const result = await query(db, sqlite,
    `SELECT r.id,r.title,r.owner_id AS "ownerId",r.created_at AS "createdAt",(SELECT COUNT(*) FROM nalu_community_members m WHERE m.room_id=r.id) AS "memberCount"
     FROM nalu_community_rooms r JOIN nalu_community_members mine ON mine.room_id=r.id WHERE mine.user_id=$1 ORDER BY r.created_at DESC LIMIT 100`, undefined, [userId])
  return sqlite ? result.results : result.rows
}
async function messages(db: Db, sqlite: boolean, roomId: string, before?: number) {
  const filter = before ? ' AND m.created_at < $2' : ''
  const params = before ? [roomId, before] : [roomId]
  const result = await query(db, sqlite,
    `SELECT m.id,m.content,m.created_at AS "createdAt",m.user_id AS "userId",u.display_name AS name,COALESCE(a.value,'') AS avatar
     FROM nalu_community_messages m JOIN nalu_users u ON u.id=m.user_id
     LEFT JOIN nalu_user_data a ON a.user_id=m.user_id AND a.key='nalu-human-avatar'
     WHERE m.room_id=$1${filter} ORDER BY m.created_at DESC LIMIT 100`, undefined, params)
  return (sqlite ? result.results : result.rows).reverse()
}

export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  res.setHeader('Cache-Control', 'no-store')
  const token = readToken(req)
  if (!token) return res.status(401).json({ error: 'Sign in to use shared chats.' })
  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}
  if (!body || Array.isArray(body) || typeof body !== 'object' || Buffer.byteLength(JSON.stringify(body)) > 12_000) return res.status(400).json({ error: 'Invalid shared-chat request.' })
  let backend: ConnectionBackend | undefined
  try {
    backend = connectionBackend(); await backend.connect()
    const userId = await backend.userId(token)
    if (!userId) return res.status(401).json({ error: 'Sign in to use shared chats.' })
    const sqlite = backend.client instanceof CloudflareStore, db = backend.client as unknown as Db
    if (!sqlite) await ensurePg(db)
    const action = String(body.action || '')
    if (req.method === 'GET' || action === 'list') return res.status(200).json({ rooms: await listRooms(db, sqlite, userId) })
    if (action === 'create') {
      const title = clean(body.title, MAX_TITLE)
      if (!title || title.length > MAX_TITLE) return res.status(400).json({ error: 'Enter a room name of up to 80 characters.' })
      const roomId = id(), at = now()
      if (sqlite) await db.query('INSERT INTO nalu_community_rooms(id,title,owner_id,created_at) VALUES(?1,?2,?3,?4)', [roomId,title,userId,at])
      else await db.query('INSERT INTO nalu_community_rooms(id,title,owner_id,created_at) VALUES($1,$2,$3,$4)', [roomId,title,userId,at])
      await query(db, sqlite,'INSERT INTO nalu_community_members(room_id,user_id,role,joined_at) VALUES($1,$2,\'owner\',$3)', undefined,[roomId,userId,at])
      return res.status(200).json({ room: { id: roomId, title, ownerId: userId, createdAt: at, memberCount: 1 } })
    }
    if (action === 'invite') {
      const roomId = clean(body.roomId, 80)
      if (!await member(db, sqlite, roomId, userId)) return res.status(404).json({ error: 'This shared chat was not found.' })
      const raw = randomBytes(32).toString('base64url'), expiresAt = now() + INVITE_MS
      await query(db, sqlite,'INSERT INTO nalu_community_invites(token_hash,room_id,created_by,expires_at) VALUES($1,$2,$3,$4)', undefined,[hash(raw),roomId,userId,expiresAt])
      return res.status(200).json({ token: raw, expiresAt })
    }
    if (action === 'join') {
      const invite = clean(body.token, 100)
      if (invite.length < 32) return res.status(400).json({ error: 'This invite link is invalid or expired.' })
      const inviteRow = await query(db, sqlite,'SELECT room_id AS "roomId" FROM nalu_community_invites WHERE token_hash=$1 AND expires_at>$2', undefined, [hash(invite), now()])
      const row = sqlite ? inviteRow.results?.[0] : inviteRow.rows?.[0]
      if (!row) return res.status(404).json({ error: 'This invite link is invalid or expired.' })
      const roomId = String(row.roomId)
      await query(db, sqlite,'INSERT INTO nalu_community_members(room_id,user_id,role,joined_at) VALUES($1,$2,\'member\',$3) ON CONFLICT(room_id,user_id) DO NOTHING', undefined,[roomId,userId,now()])
      const rooms = await listRooms(db, sqlite, userId)
      return res.status(200).json({ room: rooms.find((room: any) => room.id === roomId) })
    }
    const roomId = clean(body.roomId, 80)
    if (!roomId || !await member(db, sqlite, roomId, userId)) return res.status(404).json({ error: 'This shared chat was not found.' })
    if (action === 'messages') {
      const before = Number.isSafeInteger(body.before) && body.before > 0 ? Number(body.before) : undefined
      return res.status(200).json({ messages: await messages(db, sqlite, roomId, before) })
    }
    if (action === 'send') {
      const content = clean(body.content, MAX_MESSAGE)
      if (!content || content.length > MAX_MESSAGE) return res.status(400).json({ error: 'Write a message of up to 4,000 characters.' })
      const cutoff = now() - 60_000
      const recent = await query(db, sqlite,'SELECT COUNT(*) AS count FROM nalu_community_messages WHERE room_id=$1 AND user_id=$2 AND created_at>$3', undefined,[roomId,userId,cutoff])
      const count = Number((sqlite ? recent.results?.[0] : recent.rows?.[0])?.count || 0)
      if (count >= 30) return res.status(429).json({ error: 'Slow down a little and try again in a minute.' })
      const messageId = id(), at = now()
      await query(db, sqlite,'INSERT INTO nalu_community_messages(id,room_id,user_id,content,created_at) VALUES($1,$2,$3,$4,$5)', undefined,[messageId,roomId,userId,content,at])
      return res.status(200).json({ messages: await messages(db, sqlite, roomId), sentId: messageId })
    }
    if (action === 'leave') {
      const role = sqlite ? (await db.query('SELECT role FROM nalu_community_members WHERE room_id=?1 AND user_id=?2',[roomId,userId])).results?.[0]?.role : (await db.query('SELECT role FROM nalu_community_members WHERE room_id=$1 AND user_id=$2',[roomId,userId])).rows?.[0]?.role
      if (role === 'owner') return res.status(400).json({ error: 'Transfer the room before its owner leaves.' })
      await query(db, sqlite,'DELETE FROM nalu_community_members WHERE room_id=$1 AND user_id=$2',undefined,[roomId,userId])
      return res.status(200).json({ ok: true })
    }
    return res.status(400).json({ error: 'Unknown shared-chat action.' })
  } catch {
    return res.status(500).json({ error: 'Shared chats are unavailable right now. Try again.' })
  } finally { await backend?.close().catch(() => {}) }
}
