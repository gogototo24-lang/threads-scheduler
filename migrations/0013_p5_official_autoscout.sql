-- P5 official-source autonomous scouting: de-duplicated execution history.
-- Never stores API secrets. Each 10-minute slot can be claimed once.
CREATE TABLE IF NOT EXISTS p5_official_scout_runs (
  slot TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL DEFAULT 0,
  submitted INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  last_action_id TEXT,
  last_permalink TEXT,
  detail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_p5_official_runs_started ON p5_official_scout_runs(started_at DESC);
