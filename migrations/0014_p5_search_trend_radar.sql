-- P5 broadened topic scouting: official Google Trends Taiwan RSS.
-- A Google search trend is a signal, not verification that an associated claim is true.
-- This radar does not create Threads publishing actions.
CREATE TABLE IF NOT EXISTS p5_trend_radar_runs (
 slot TEXT PRIMARY KEY,
 status TEXT NOT NULL,
 scanned INTEGER NOT NULL DEFAULT 0,
 newly_detected INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 started_at TEXT NOT NULL,
 finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_p5_trend_runs_time ON p5_trend_radar_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS p5_search_trends (
 trend_id TEXT PRIMARY KEY,
 keyword TEXT NOT NULL,
 region TEXT NOT NULL DEFAULT 'TW',
 source_url TEXT NOT NULL,
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 published_at TEXT,
 traffic_label TEXT,
 traffic_lower_bound INTEGER NOT NULL DEFAULT 0,
 category_hint TEXT,
 moderation TEXT NOT NULL DEFAULT 'unreviewed',
 status TEXT NOT NULL DEFAULT 'discovered',
 CHECK(status IN ('discovered','rejected','verified','published'))
);
CREATE INDEX IF NOT EXISTS idx_p5_trend_search_rank
ON p5_search_trends(last_seen_at DESC,traffic_lower_bound DESC);
