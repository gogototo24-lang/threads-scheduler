-- CatPaw Factory P5 v0.3 public interaction execution.
-- Public replies/quotes/reposts only. Direct messages are intentionally unsupported.

ALTER TABLE social_candidates ADD COLUMN source_thread_id TEXT;

CREATE TABLE IF NOT EXISTS social_actions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT,
  reply_draft_id TEXT,
  platform TEXT NOT NULL DEFAULT 'threads',
  action_type TEXT NOT NULL CHECK (action_type IN ('reply','quote','repost','original_post')),
  target_thread_id TEXT,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  external_thread_id TEXT,
  permalink TEXT,
  risk_level TEXT NOT NULL DEFAULT 'low',
  error TEXT,
  scheduled_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (candidate_id) REFERENCES social_candidates(id),
  FOREIGN KEY (reply_draft_id) REFERENCES social_reply_drafts(id)
);

CREATE INDEX IF NOT EXISTS idx_social_actions_queue
ON social_actions(status,scheduled_at,created_at);

CREATE INDEX IF NOT EXISTS idx_social_actions_target
ON social_actions(target_thread_id,sent_at);
