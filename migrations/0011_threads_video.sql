-- Threads VIDEO media containers are processed asynchronously by the per-minute cron.
-- Existing TEXT / IMAGE posts are unaffected.
ALTER TABLE posts ADD COLUMN video_container_id TEXT;
ALTER TABLE posts ADD COLUMN video_started_at TEXT;
ALTER TABLE posts ADD COLUMN video_next_check_at TEXT;
ALTER TABLE posts ADD COLUMN video_publish_requested_at TEXT;

CREATE INDEX IF NOT EXISTS idx_posts_video_processing
  ON posts(media_type, status, video_next_check_at);
