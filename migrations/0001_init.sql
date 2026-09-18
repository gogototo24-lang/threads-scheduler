CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT 'TEXT',
  media_key TEXT,
  media_url TEXT,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  attempts INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, scheduled_at);
