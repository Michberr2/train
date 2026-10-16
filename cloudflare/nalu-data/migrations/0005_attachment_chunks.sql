-- Keep binary files in private R2 and only immutable references in D1.
-- The PostgreSQL parts table remains in the baseline for recovery tooling.
CREATE TABLE IF NOT EXISTS nalu_attachment_chunks (
  attachment_id TEXT NOT NULL REFERENCES nalu_task_attachments(id) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK(part>=0),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=786432),
  PRIMARY KEY(attachment_id,part)
);
