-- Conservative reservations keep Nalu file operations below R2's included
-- monthly allowance. Files are never deleted automatically to recover capacity.
CREATE TABLE IF NOT EXISTS nalu_storage_allowances (
  metric TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0)
);
