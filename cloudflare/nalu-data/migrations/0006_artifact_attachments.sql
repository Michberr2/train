-- Generated AutoPilot outputs use the same verified private-file storage as
-- downloaded task attachments. Existing source-schema columns remain intact.
ALTER TABLE nalu_autopilot_artifacts ADD COLUMN attachment_id TEXT
  REFERENCES nalu_task_attachments(id);
