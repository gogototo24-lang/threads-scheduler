-- CatPaw Universe HQ v1: control-plane foundation only.
-- No provider execution, no paid generation, and no social publishing.
CREATE TABLE IF NOT EXISTS hq_roles (
  role_id TEXT PRIMARY KEY,
  floor_name TEXT NOT NULL,
  suggested_provider TEXT NOT NULL,
  duty TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','interviewing','appointed')),
  appointed_name TEXT,
  connector_verified INTEGER NOT NULL DEFAULT 0 CHECK(connector_verified IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO hq_roles (role_id, floor_name, suggested_provider, duty, status, connector_verified)
VALUES
  ('HQ','總指揮塔','Gemini Enterprise','跨產線派工與查核','candidate',0),
  ('A','貓掌與喵台灣製片部','GPT-6','貓掌江湖／喵台灣創作與社群','candidate',0),
  ('B','視覺寫真部','Grok','成年合法非露骨時尚寫真','candidate',0),
  ('C','音樂 MV 部','Gemini','歌曲分析、MV 分鏡與音畫同步','candidate',0),
  ('D','長篇漫劇部','Claude','長篇劇本、人物連貫與分鏡','candidate',0),
  ('W','Muse 工人區','Muse Spark','大量低風險子任務、標註與初步檢查','candidate',0);

CREATE TABLE IF NOT EXISTS hq_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  role_id TEXT,
  job_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hq_audit_latest ON hq_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hq_jobs_source ON factory_jobs(source_system, created_at DESC);
