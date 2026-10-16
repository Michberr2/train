ALTER TABLE nalu_notes ADD COLUMN attachment_id TEXT REFERENCES nalu_task_attachments(id);
