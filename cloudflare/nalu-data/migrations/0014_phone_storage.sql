CREATE TABLE nalu_phone_states (
  user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
  sid TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)),
  PRIMARY KEY(user_id,sid)
);
CREATE UNIQUE INDEX nalu_phone_plan_pending ON nalu_phone_plan_turns(user_id,sid) WHERE status IN ('queued','working');
ALTER TABLE nalu_outbound_calls ADD COLUMN mutation_token TEXT NOT NULL DEFAULT '';
CREATE TABLE nalu_outbound_receipts (
  call_id TEXT PRIMARY KEY REFERENCES nalu_outbound_calls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
  document TEXT NOT NULL CHECK(json_valid(document))
);
