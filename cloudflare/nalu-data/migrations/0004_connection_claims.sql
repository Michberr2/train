-- Durable refresh ownership cannot expire into a duplicate rotation after a
-- lost provider response. Reconnecting creates a new encrypted source version.
CREATE TABLE IF NOT EXISTS nalu_connection_refreshes (
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','saved','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,connection_id,source_sha256),
  FOREIGN KEY(user_id,connection_id) REFERENCES nalu_connections(user_id,id) ON DELETE CASCADE
);
ALTER TABLE nalu_pipeline_deliveries ADD COLUMN revision TEXT NOT NULL DEFAULT '';
