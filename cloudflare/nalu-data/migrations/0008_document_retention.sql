ALTER TABLE nalu_document_parts ADD COLUMN touched_at TEXT NOT NULL DEFAULT '2099-01-01T00:00:00.000Z';
UPDATE nalu_document_parts SET touched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
CREATE INDEX nalu_document_parts_retention ON nalu_document_parts(touched_at);
