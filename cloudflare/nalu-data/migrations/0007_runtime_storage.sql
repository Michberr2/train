CREATE TABLE nalu_flow_leases (
  user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(user_id,flow_id)
);
CREATE TABLE nalu_usage_reservations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  counted INTEGER NOT NULL DEFAULT 0 CHECK(counted IN (0,1)),
  released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX nalu_usage_reservations_day ON nalu_usage_reservations(day);
ALTER TABLE nalu_studio_images ADD COLUMN attachment_id TEXT REFERENCES nalu_task_attachments(id);
