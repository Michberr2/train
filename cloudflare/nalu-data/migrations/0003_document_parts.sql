-- Large histories retain their original JSON encoding. Immutable, per-owner
-- pieces fit D1's row limit; a manifest is published in the same transaction
-- as the document revision. An incomplete upload never replaces saved data.
CREATE TABLE IF NOT EXISTS nalu_document_parts (
  owner TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  base64 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=524288),
  PRIMARY KEY(owner,sha256)
);
CREATE TABLE IF NOT EXISTS nalu_document_manifests (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  parts TEXT NOT NULL CHECK(json_valid(parts)),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=67108864),
  PRIMARY KEY(owner,key),
  FOREIGN KEY(owner,key) REFERENCES nalu_user_data(user_id,key) ON DELETE CASCADE
);
