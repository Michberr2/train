-- Durable, owner-scoped scheduling/cancellation commands. A stop received
-- before a delayed delegation prevents that request from ever starting work.
CREATE TABLE IF NOT EXISTS nalu_swarm_delegations (
  owner_id TEXT NOT NULL REFERENCES nalu_swarm_accounts(owner_id) ON DELETE CASCADE,
  id TEXT NOT NULL,project_id TEXT,thread TEXT,
  payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(owner_id,id)
);
CREATE INDEX IF NOT EXISTS nalu_swarm_delegations_project ON nalu_swarm_delegations(owner_id,project_id);
