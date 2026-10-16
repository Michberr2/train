-- Nalu Cloudflare schema. No production data is imported by this file.
PRAGMA defer_foreign_keys=ON;

-- api/_autopilotArtifacts.ts
CREATE TABLE IF NOT EXISTS nalu_autopilot_artifacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    meta TEXT NOT NULL,
    bytes BLOB NOT NULL CHECK (length(bytes) <= 1048576),
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

-- api/_connectionMedia.ts
CREATE TABLE IF NOT EXISTS nalu_connection_media (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL REFERENCES nalu_task_attachments(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+24 hours')));

-- api/_connectionReviews.ts
CREATE TABLE IF NOT EXISTS nalu_connection_reviews (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, delivery_key TEXT NOT NULL,
    connection_id TEXT NOT NULL, account_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), checked_at TEXT, PRIMARY KEY(user_id,delivery_key));

-- api/_db.ts
CREATE TABLE IF NOT EXISTS nalu_users (
      id           TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      salt         TEXT NOT NULL,
      hash         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

-- api/_db.ts
CREATE TABLE IF NOT EXISTS nalu_sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

-- api/_db.ts
CREATE TABLE IF NOT EXISTS nalu_user_data (
      user_id    TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      key        TEXT NOT NULL,
      value      TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, key)
    );

-- api/_db.ts
CREATE TABLE IF NOT EXISTS nalu_tasks (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      source     TEXT NOT NULL DEFAULT 'cli',
      title      TEXT NOT NULL,
      detail     TEXT,
      status     TEXT NOT NULL DEFAULT 'running',
      progress   REAL NOT NULL DEFAULT 0,
      events     TEXT NOT NULL DEFAULT '[]',
      meta       TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

-- api/_db.ts
CREATE TABLE IF NOT EXISTS nalu_password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT FALSE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

-- api/_limits.ts
CREATE TABLE IF NOT EXISTS nalu_usage (
  subject TEXT NOT NULL,
  day     DATE NOT NULL,
  kind    TEXT NOT NULL,
  count   INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day, kind)
);

-- api/_messageStore.ts
CREATE TABLE IF NOT EXISTS nalu_messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','image')),
      from_number TEXT NOT NULL, to_number TEXT NOT NULL, text TEXT NOT NULL,
      media TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'queued',
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, carrier_id TEXT UNIQUE,
      member_id TEXT, task_id TEXT, error TEXT, started_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(user_id, request_id)
    );

-- api/_messageStore.ts
CREATE TABLE IF NOT EXISTS nalu_message_media (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      mime TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

-- api/_messageStore.ts
CREATE TABLE IF NOT EXISTS nalu_message_receipts (
      carrier_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, to_number TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

-- api/_notebook.ts
CREATE TABLE IF NOT EXISTS nalu_notes (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, id TEXT NOT NULL,
    document TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(user_id,id));

-- api/_notebook.ts
CREATE TABLE IF NOT EXISTS nalu_note_groups (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, id TEXT NOT NULL,
    document TEXT NOT NULL, PRIMARY KEY(user_id,id));

-- api/_notebook.ts
CREATE TABLE IF NOT EXISTS nalu_note_operations (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(user_id,id));

-- api/_notebookEmail.ts
CREATE TABLE IF NOT EXISTS nalu_note_deliveries(user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,id TEXT NOT NULL,note_id TEXT NOT NULL,fingerprint TEXT NOT NULL,document TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY KEY(user_id,id));

-- api/_oauthHandler.ts
CREATE TABLE IF NOT EXISTS nalu_oauth_states(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,provider TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'launch',expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')));

-- api/_outboundCalls.ts
CREATE TABLE IF NOT EXISTS nalu_outbound_calls (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, brief TEXT NOT NULL,
    voice TEXT NOT NULL, member_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'prepared', sid TEXT UNIQUE,
    expires_at TEXT NOT NULL, turns TEXT NOT NULL DEFAULT '[]', turn INTEGER NOT NULL DEFAULT 0,
    outcome TEXT, summary TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '',
    response_xml TEXT NOT NULL DEFAULT '', request_hash TEXT NOT NULL DEFAULT '',
    cancel_requested INTEGER NOT NULL DEFAULT FALSE, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(user_id,request_id));

-- api/_phonePlans.ts
CREATE TABLE IF NOT EXISTS nalu_phone_plan_turns (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,sid TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',
 input TEXT NOT NULL,snapshot TEXT,reply TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));

-- api/_pipelineDelivery.ts
CREATE TABLE IF NOT EXISTS nalu_pipeline_deliveries (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    delivery_key TEXT NOT NULL, result TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, delivery_key)
  );

-- api/_push.ts
CREATE TABLE IF NOT EXISTS nalu_push_devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    token TEXT NOT NULL, environment TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT TRUE,
    enabled_since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

-- api/_push.ts
CREATE TABLE IF NOT EXISTS nalu_push_deliveries (
    device_id TEXT NOT NULL REFERENCES nalu_push_devices(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
    reason TEXT, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(device_id,event_id)
  );

-- api/_studioImages.ts
CREATE TABLE IF NOT EXISTS nalu_studio_images (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    request_key TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','ready','failed')),
    lease_id TEXT,
    lease_until TEXT,
    quota_day DATE,
    bytes BLOB CHECK (length(bytes) <= 2097152),
    mime_type TEXT,
    width INT,
    height INT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (user_id, request_key)
  );

-- api/_taskAttachments.ts
CREATE TABLE IF NOT EXISTS nalu_task_attachments (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    meta TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT FALSE,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));

-- api/_taskAttachments.ts
CREATE TABLE IF NOT EXISTS nalu_task_attachment_parts (
    attachment_id TEXT NOT NULL REFERENCES nalu_task_attachments(id) ON DELETE CASCADE,
    part INTEGER NOT NULL CHECK(part>=0),bytes BLOB NOT NULL CHECK(length(bytes)<=786432),PRIMARY KEY(attachment_id,part));

-- api/_taskCompletion.ts
CREATE TABLE IF NOT EXISTS nalu_task_notifications (
      task_id TEXT NOT NULL REFERENCES nalu_tasks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL, status TEXT NOT NULL, carrier_id TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY(task_id,channel)
    );

-- api/_taskQuestions.ts
CREATE TABLE IF NOT EXISTS nalu_task_questions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES nalu_task_jobs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    text TEXT NOT NULL, answer TEXT, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), answered_at TEXT,
    notification_status TEXT NOT NULL DEFAULT 'pending', call_sid TEXT, notification_error TEXT, phone_draft TEXT,
    UNIQUE(task_id,id)
  );

-- api/_tasks.ts
CREATE TABLE IF NOT EXISTS nalu_task_jobs (
      id TEXT PRIMARY KEY REFERENCES nalu_tasks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      repo TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'desktop',
      flow_id TEXT,
      mode TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      worker_id TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (user_id, request_id)
    );

-- api/_tasks.ts
CREATE TABLE IF NOT EXISTS nalu_task_workers (
      user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      worker_id TEXT NOT NULL,
      repos TEXT NOT NULL DEFAULT '[]',
      kinds TEXT NOT NULL DEFAULT '[]',
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, worker_id)
    );

-- api/_team.ts
CREATE TABLE IF NOT EXISTS nalu_team_members (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, role TEXT NOT NULL, responsibilities TEXT NOT NULL,
    workspace TEXT NOT NULL, extension INTEGER NOT NULL CHECK (extension BETWEEN 100 AND 9999),
    voice TEXT NOT NULL, active INTEGER NOT NULL DEFAULT TRUE,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(user_id, extension), UNIQUE(user_id, request_id)
  );

-- api/connect.ts
CREATE TABLE IF NOT EXISTS nalu_connections (
      id         TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      app        TEXT NOT NULL,
      label      TEXT NOT NULL,
      method     TEXT NOT NULL DEFAULT 'webhook',
      username   TEXT,
      endpoint   TEXT,
      enc_secret TEXT,
      status     TEXT NOT NULL DEFAULT 'connected',
      meta       TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, id)
    );

-- api/connect.ts
CREATE TABLE IF NOT EXISTS nalu_inbound (
      id         TEXT PRIMARY KEY,
      conn_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      sender     TEXT,
      subject    TEXT,
      body       TEXT,
      meta       TEXT NOT NULL DEFAULT '{}',
      received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

-- api/data.ts
CREATE TABLE IF NOT EXISTS nalu_shares (id TEXT PRIMARY KEY, html TEXT NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));

-- api/_db.ts
ALTER TABLE nalu_users ADD COLUMN recovery_hash TEXT;

-- api/_db.ts
ALTER TABLE nalu_users ADD COLUMN phone TEXT;

-- api/_oauthHandler.ts
ALTER TABLE nalu_oauth_states ADD COLUMN return_to TEXT;

-- api/_oauthHandler.ts
ALTER TABLE nalu_oauth_states ADD COLUMN code_verifier TEXT;

-- api/_oauthHandler.ts
ALTER TABLE nalu_oauth_states ADD COLUMN connection_id TEXT;

-- api/_outboundCalls.ts
ALTER TABLE nalu_outbound_calls ADD COLUMN delivery TEXT;

-- api/connect.ts
ALTER TABLE nalu_connections ADD COLUMN ingest_token TEXT;

-- api/_autopilotArtifacts.ts
CREATE INDEX IF NOT EXISTS nalu_autopilot_artifacts_user_created
    ON nalu_autopilot_artifacts (user_id, created_at DESC, id DESC);

-- api/_db.ts
CREATE INDEX IF NOT EXISTS nalu_users_phone ON nalu_users (phone);

-- api/_db.ts
CREATE INDEX IF NOT EXISTS nalu_tasks_user_updated
      ON nalu_tasks (user_id, updated_at DESC);

-- api/_messageStore.ts
CREATE INDEX IF NOT EXISTS nalu_messages_pending ON nalu_messages(user_id,status,created_at);

-- api/_outboundCalls.ts
CREATE INDEX IF NOT EXISTS nalu_outbound_calls_owner ON nalu_outbound_calls(user_id,created_at DESC);

-- api/_phonePlans.ts
CREATE INDEX IF NOT EXISTS nalu_phone_plan_sid ON nalu_phone_plan_turns(user_id,sid,created_at DESC);

-- api/_push.ts
CREATE INDEX IF NOT EXISTS nalu_push_devices_owner ON nalu_push_devices(user_id);

-- api/_studioImages.ts
CREATE INDEX IF NOT EXISTS nalu_studio_images_user_created ON nalu_studio_images(user_id, created_at DESC);

-- api/_taskAttachments.ts
CREATE INDEX IF NOT EXISTS nalu_task_attachments_owner ON nalu_task_attachments(user_id,created_at DESC,id);

-- api/_taskQuestions.ts
CREATE UNIQUE INDEX IF NOT EXISTS nalu_one_pending_question ON nalu_task_questions(task_id) WHERE status='pending';

-- api/_tasks.ts
CREATE INDEX IF NOT EXISTS nalu_task_jobs_pending ON nalu_task_jobs (user_id, status, created_at);

-- api/_team.ts
CREATE UNIQUE INDEX IF NOT EXISTS nalu_team_names ON nalu_team_members (user_id, lower(name));

-- api/connect.ts
CREATE INDEX IF NOT EXISTS nalu_inbound_conn ON nalu_inbound (conn_id, received_at DESC);

-- api/connect.ts
CREATE INDEX IF NOT EXISTS nalu_conn_ingest ON nalu_connections (ingest_token);

-- Cloudflare atomic document updates
CREATE TABLE IF NOT EXISTS nalu_store_revisions (scope TEXT PRIMARY KEY, revision TEXT NOT NULL DEFAULT '');
