-- Server-owned browser identities. Never expose through synced user documents.
CREATE TABLE IF NOT EXISTS nalu_browser_workspaces (
  user_id TEXT PRIMARY KEY REFERENCES nalu_users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT '{}',
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
