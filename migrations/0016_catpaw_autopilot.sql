-- CatPaw native video autopilot: schedule/authorization separated from paid generation and posting.
CREATE TABLE IF NOT EXISTS autopilot_series (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS autopilot_runs (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES autopilot_series(id),
  local_day TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  p3_job_id TEXT,
  post_id TEXT,
  video_url TEXT,
  estimated_cost_twd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(series_id,local_day)
);
CREATE INDEX IF NOT EXISTS idx_autopilot_runs_status
  ON autopilot_runs(status,updated_at);
CREATE INDEX IF NOT EXISTS idx_autopilot_runs_series_day
  ON autopilot_runs(series_id,local_day);
