-- CatPaw Factory P5 v0.4 Cross-Platform Trend Radar.
-- External public content is transformed into original Threads posts with attribution/source links.

CREATE TABLE IF NOT EXISTS social_cross_platform_items (
  id TEXT PRIMARY KEY,
  source_platform TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_author TEXT,
  title TEXT,
  source_summary TEXT,
  content_type TEXT NOT NULL DEFAULT 'post',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  heat_score REAL NOT NULL DEFAULT 0,
  relevance_score REAL NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'low',
  universe TEXT NOT NULL DEFAULT '喵台灣宇宙',
  remix_text TEXT,
  status TEXT NOT NULL DEFAULT 'scored',
  action_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_url)
);

CREATE INDEX IF NOT EXISTS idx_social_cross_platform_rank
ON social_cross_platform_items(status,heat_score DESC,relevance_score DESC,created_at DESC);
