CREATE TABLE IF NOT EXISTS trends (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_name TEXT,
  fetched_at TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  topic TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content_drafts (
  id TEXT PRIMARY KEY,
  trend_id TEXT NOT NULL,
  universe TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  copy TEXT NOT NULL,
  visual_prompt TEXT NOT NULL,
  suggested_at TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  image_job_id TEXT,
  video_job_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (trend_id) REFERENCES trends(id)
);

CREATE TABLE IF NOT EXISTS media_jobs (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generating', 'completed', 'failed')),
  input_prompt TEXT NOT NULL,
  output_key TEXT,
  output_url TEXT,
  provider_job_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (draft_id) REFERENCES content_drafts(id)
);

CREATE INDEX IF NOT EXISTS idx_trends_fetched ON trends(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_review ON content_drafts(review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, updated_at);
