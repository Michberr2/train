-- Carrier consent is server-owned, separate from editable account documents.
CREATE TABLE nalu_message_consents (
  user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)),
  PRIMARY KEY(user_id,phone)
);
ALTER TABLE nalu_messages ADD COLUMN mutation_token TEXT;
ALTER TABLE nalu_message_media ADD COLUMN attachment_id TEXT REFERENCES nalu_task_attachments(id);
ALTER TABLE nalu_message_media ADD COLUMN byte_length INTEGER CHECK(byte_length>=0 AND byte_length<=900000);
CREATE INDEX IF NOT EXISTS nalu_messages_pending ON nalu_messages(user_id,status,created_at,id);
CREATE TABLE nalu_phone_leases (
  user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(user_id,scope)
);
CREATE TABLE nalu_call_deliveries (
  user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)),
  mutation_token TEXT NOT NULL,
  PRIMARY KEY(user_id,id)
);
