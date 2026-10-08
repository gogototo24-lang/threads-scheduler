-- CatPaw AI Factory P1 shared core.
-- This migration prepares D1 persistence only. It does not enable any paid provider
-- and does not change existing scheduler/publisher behavior.

CREATE TABLE IF NOT EXISTS factory_jobs (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'factory.job.v1',
  pipeline_id TEXT NOT NULL CHECK (pipeline_id IN ('A','B','C','D')),
  universe TEXT,
  mode TEXT NOT NULL DEFAULT 'mock' CHECK (mode IN ('mock','live')),
  status TEXT NOT NULL DEFAULT 'draft',
  source_system TEXT,
  source_id TEXT,
  canon_ref_json TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_spec_json TEXT NOT NULL DEFAULT '{}',
  paid_enabled INTEGER NOT NULL DEFAULT 0 CHECK (paid_enabled IN (0,1)),
  publish_enabled INTEGER NOT NULL DEFAULT 0 CHECK (publish_enabled IN (0,1)),
  budget_currency TEXT NOT NULL DEFAULT 'TWD',
  budget_max REAL,
  estimated_cost REAL NOT NULL DEFAULT 0,
  actual_cost REAL NOT NULL DEFAULT 0,
  asset_approval TEXT NOT NULL DEFAULT 'pending',
  paid_batch_approval TEXT NOT NULL DEFAULT 'pending',
  publish_approval TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS factory_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  provider TEXT NOT NULL,
  provider_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT,
  output_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  mock INTEGER NOT NULL DEFAULT 1 CHECK (mock IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES factory_jobs(id)
);

CREATE TABLE IF NOT EXISTS factory_assets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  step_id TEXT,
  kind TEXT NOT NULL,
  storage_key TEXT,
  url TEXT,
  mock INTEGER NOT NULL DEFAULT 1 CHECK (mock IN (0,1)),
  publishable INTEGER NOT NULL DEFAULT 0 CHECK (publishable IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES factory_jobs(id)
);

CREATE TABLE IF NOT EXISTS factory_costs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  step_id TEXT,
  provider TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD',
  estimated_amount REAL NOT NULL DEFAULT 0,
  actual_amount REAL NOT NULL DEFAULT 0,
  provider_credits REAL,
  task_cost_time_seconds REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES factory_jobs(id)
);

CREATE TABLE IF NOT EXISTS factory_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES factory_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_factory_jobs_pipeline_status ON factory_jobs(pipeline_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_factory_steps_job ON factory_steps(job_id,step_order);
CREATE INDEX IF NOT EXISTS idx_factory_assets_job ON factory_assets(job_id,created_at);
CREATE INDEX IF NOT EXISTS idx_factory_costs_job ON factory_costs(job_id,created_at);
CREATE INDEX IF NOT EXISTS idx_factory_events_job ON factory_events(job_id,created_at);
