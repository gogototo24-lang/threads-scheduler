-- P5 real automated publishing, sourced from observed Taiwan Google Trends.
-- Separate from the read-only signal radar and the official-source scout.
CREATE TABLE IF NOT EXISTS p5_trend_autopost_runs (
  slot TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0,
  attempted INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  last_trend_id TEXT,
  last_action_id TEXT,
  last_permalink TEXT,
  detail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_p5_trend_autopost_time
 ON p5_trend_autopost_runs(started_at DESC);
