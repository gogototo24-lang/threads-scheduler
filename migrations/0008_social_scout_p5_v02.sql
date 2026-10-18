-- CatPaw Factory P5 v0.2 High-Reach Radar + Relationship Score + Patrol Queue.
-- Observed/public metrics only; no scraping or auto-reply is enabled here.

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'threads',
  handle TEXT NOT NULL,
  display_name TEXT,
  profile_url TEXT,
  category TEXT,
  followers INTEGER NOT NULL DEFAULT 0,
  avg_views REAL NOT NULL DEFAULT 0,
  avg_likes REAL NOT NULL DEFAULT 0,
  avg_replies REAL NOT NULL DEFAULT 0,
  avg_reposts REAL NOT NULL DEFAULT 0,
  posts_per_day REAL NOT NULL DEFAULT 0,
  observed_posts INTEGER NOT NULL DEFAULT 0,
  reach_score REAL NOT NULL DEFAULT 0,
  relationship_score REAL NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform,handle)
);

CREATE TABLE IF NOT EXISTS social_relationship_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0,
  source_url TEXT,
  note TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES social_accounts(id)
);

ALTER TABLE social_candidates ADD COLUMN account_id TEXT;
ALTER TABLE social_candidates ADD COLUMN breakout_score REAL NOT NULL DEFAULT 0;
ALTER TABLE social_candidates ADD COLUMN relationship_score REAL NOT NULL DEFAULT 0;
ALTER TABLE social_candidates ADD COLUMN patrol_score REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_social_accounts_reach
ON social_accounts(platform,reach_score DESC,relationship_score DESC);

CREATE INDEX IF NOT EXISTS idx_social_relationship_account
ON social_relationship_events(account_id,occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_candidates_patrol
ON social_candidates(status,patrol_score DESC,total_score DESC,created_at DESC);
