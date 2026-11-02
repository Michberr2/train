CREATE TABLE IF NOT EXISTS nalu_community_rooms (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nalu_community_members (
  room_id TEXT NOT NULL REFERENCES nalu_community_rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, role TEXT NOT NULL,
  joined_at INTEGER NOT NULL, PRIMARY KEY(room_id,user_id)
);
CREATE TABLE IF NOT EXISTS nalu_community_invites (
  token_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES nalu_community_rooms(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nalu_community_messages (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES nalu_community_rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nalu_community_member_user ON nalu_community_members(user_id,joined_at);
CREATE INDEX IF NOT EXISTS nalu_community_message_room ON nalu_community_messages(room_id,created_at);
