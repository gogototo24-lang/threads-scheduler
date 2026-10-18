-- CatPaw Factory P5 Social Scout.
-- Half-automatic social opportunity discovery/reply drafting.
-- No automatic replies, DMs, or publishing are enabled by this migration.

CREATE TABLE IF NOT EXISTS social_candidates (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'threads',
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_url TEXT NOT NULL,
  source_author TEXT,
  source_text TEXT NOT NULL,
  topic TEXT,
  universe TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  heat_score REAL NOT NULL DEFAULT 0,
  relevance_score REAL NOT NULL DEFAULT 0,
  replyability_score REAL NOT NULL DEFAULT 0,
  risk_score REAL NOT NULL DEFAULT 0,
  traffic_score REAL NOT NULL DEFAULT 0,
  total_score REAL NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'scored',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS social_reply_drafts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT '喵台灣宇宙',
  reply_text TEXT NOT NULL,
  rationale TEXT,
  qa_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending_review',
  approved_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (candidate_id) REFERENCES social_candidates(id)
);

CREATE TABLE IF NOT EXISTS social_outcomes (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  reply_draft_id TEXT,
  platform TEXT NOT NULL DEFAULT 'threads',
  external_reply_id TEXT,
  impressions INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  profile_visits INTEGER NOT NULL DEFAULT 0,
  follows INTEGER NOT NULL DEFAULT 0,
  measured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (candidate_id) REFERENCES social_candidates(id),
  FOREIGN KEY (reply_draft_id) REFERENCES social_reply_drafts(id)
);

CREATE INDEX IF NOT EXISTS idx_social_candidates_status_score
ON social_candidates(status,total_score DESC,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_reply_drafts_candidate
ON social_reply_drafts(candidate_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_outcomes_candidate
ON social_outcomes(candidate_id,measured_at DESC);
