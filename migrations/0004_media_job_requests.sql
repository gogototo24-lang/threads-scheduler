ALTER TABLE media_jobs ADD COLUMN requested_at TEXT;
CREATE INDEX IF NOT EXISTS idx_media_jobs_requested ON media_jobs(status, requested_at, updated_at);
