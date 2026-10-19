-- Isolated Swarm records. No legacy chat, task, team, or flow table is changed.
CREATE TABLE IF NOT EXISTS nalu_swarm_accounts (
  owner_id TEXT PRIMARY KEY REFERENCES nalu_users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),write_token TEXT
);
CREATE TABLE IF NOT EXISTS nalu_swarm_projects (owner_id TEXT NOT NULL REFERENCES nalu_swarm_accounts(owner_id) ON DELETE CASCADE,id TEXT NOT NULL,project_id TEXT,thread TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(owner_id,id));
CREATE TABLE IF NOT EXISTS nalu_swarm_rooms (owner_id TEXT NOT NULL REFERENCES nalu_swarm_accounts(owner_id) ON DELETE CASCADE,id TEXT NOT NULL,project_id TEXT,thread TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(owner_id,id));
CREATE TABLE IF NOT EXISTS nalu_swarm_messages (owner_id TEXT NOT NULL REFERENCES nalu_swarm_accounts(owner_id) ON DELETE CASCADE,id TEXT NOT NULL,project_id TEXT,thread TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(owner_id,id));
CREATE TABLE IF NOT EXISTS nalu_swarm_tasks (owner_id TEXT NOT NULL REFERENCES nalu_swarm_accounts(owner_id) ON DELETE CASCADE,id TEXT NOT NULL,project_id TEXT,thread TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(owner_id,id));
CREATE TABLE IF NOT EXISTS nalu_swarm_task_threads (owner_id TEXT NOT NULL REFERENCES nalu_swarm_accounts(owner_id) ON DELETE CASCADE,id TEXT NOT NULL,project_id TEXT,thread TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(owner_id,id));
CREATE TABLE IF NOT EXISTS nalu_swarm_turns (owner_id TEXT NOT NULL REFERENCES nalu_swarm_accounts(owner_id) ON DELETE CASCADE,id TEXT NOT NULL,project_id TEXT,thread TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(owner_id,id));
CREATE TABLE IF NOT EXISTS nalu_swarm_jobs (
  owner_id TEXT NOT NULL REFERENCES nalu_swarm_accounts(owner_id) ON DELETE CASCADE,
  id TEXT NOT NULL,project_id TEXT,thread TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),
  status TEXT NOT NULL,request_id TEXT NOT NULL,lease_until INTEGER,updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS nalu_swarm_projects_project ON nalu_swarm_projects(owner_id,project_id);
CREATE INDEX IF NOT EXISTS nalu_swarm_rooms_project ON nalu_swarm_rooms(owner_id,project_id);
CREATE INDEX IF NOT EXISTS nalu_swarm_messages_project ON nalu_swarm_messages(owner_id,project_id);
CREATE INDEX IF NOT EXISTS nalu_swarm_tasks_project ON nalu_swarm_tasks(owner_id,project_id);
CREATE INDEX IF NOT EXISTS nalu_swarm_task_threads_project ON nalu_swarm_task_threads(owner_id,project_id);
CREATE INDEX IF NOT EXISTS nalu_swarm_turns_project ON nalu_swarm_turns(owner_id,project_id);
CREATE INDEX IF NOT EXISTS nalu_swarm_jobs_project ON nalu_swarm_jobs(owner_id,project_id);
CREATE INDEX IF NOT EXISTS nalu_swarm_jobs_due ON nalu_swarm_jobs(status,lease_until,updated_at,owner_id);
