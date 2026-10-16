-- CatPaw Factory P4 Multi-LLM Council.
-- Decision/orchestration persistence only. Does not enable paid providers or publishing.

CREATE TABLE IF NOT EXISTS council_jobs (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'catpaw.council.v1',
  pipeline_id TEXT CHECK (pipeline_id IN ('A','B','C','D') OR pipeline_id IS NULL),
  task_type TEXT NOT NULL,
  objective TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',
  current_stage TEXT NOT NULL DEFAULT 'proposal',
  manager_provider TEXT NOT NULL DEFAULT 'openai',
  proposer_provider TEXT NOT NULL DEFAULT 'meta',
  critic_provider TEXT NOT NULL DEFAULT 'anthropic',
  verifier_provider TEXT NOT NULL DEFAULT 'anthropic',
  auto_execute INTEGER NOT NULL DEFAULT 0 CHECK (auto_execute IN (0,1)),
  max_cost_twd REAL NOT NULL DEFAULT 0,
  actual_cost_twd REAL NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  final_plan_json TEXT,
  verdict_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS council_turns (
  id TEXT PRIMARY KEY,
  council_job_id TEXT NOT NULL,
  turn_order INTEGER NOT NULL,
  stage TEXT NOT NULL,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  author_key TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'completed',
  usage_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (council_job_id) REFERENCES council_jobs(id)
);

CREATE TABLE IF NOT EXISTS council_events (
  id TEXT PRIMARY KEY,
  council_job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (council_job_id) REFERENCES council_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_council_jobs_status ON council_jobs(status,created_at);
CREATE INDEX IF NOT EXISTS idx_council_turns_job ON council_turns(council_job_id,turn_order);
CREATE INDEX IF NOT EXISTS idx_council_events_job ON council_events(council_job_id,created_at);
