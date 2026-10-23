# CatPaw Native Autopilot v1｜AITuber 公開工作流概念的獨立實作

本專案參考 AITuber **公開說明**中的「一次設定系列 → 定時製片 → 發布 → 狀態與額度管理」概念，自行撰寫 Cloudflare Worker + D1 + P3 + Threads VIDEO 版本；**沒有取得或複製 AITuber 專有程式、內部 API、素材或帳戶資料**。

官方公開參考：[Autopilot setup](https://help.aituber.app/en/article/how-to-set-up-autopilot-a1d716/)。

## 簡化的實際工作流

```text
CatPaw Universe HQ /autopilot（一個系列只設定一次）
   │
   ├─ 主題庫、正史角色 ID、已核准 Master 首幀／已授權素材庫
   ├─ 時區 Asia/Taipei、每日時間、片長、預算與發布選項
   │
Cloudflare Cron 每分鐘檢查是否到排程窗口（最多延後 19 分鐘）
   ↓
D1 autopilot_runs 依 series_id + 台北日期原子去重，每日最多一次
   ↓
帳單閘門：A 線另需 CATPAW_AUTOPILOT_PAID_ENABLED=true
   ├─ A 線：既有 P3 → RunningHub H3 參考圖→影片 5 秒
   └─ C 線：既有 P3 → AI Music Studio Editor → 合法既有短片剪輯 30/60/275 秒
   ↓
P3 provider task / 技術 QA / 非 Mock HTTPS 影片檢查
   ↓
影片 ready
   ├─ 若未同時開啟系列 autopublish 與 FACTORY_PUBLISH_ENABLED → 停在 ready
   └─ 若均明確開啟 → 建立既有 posts(VIDEO) 排程記錄（不直接重複呼叫 Meta）
       ↓
      舊有 Threads VIDEO publisher → 建立容器 → Poll FINISHED → publish
       ↓
      寫入官方 thread_id、permalink；結果不明停在 needs_attention，不自動重試
```

## 使用者能做的事（手機）

1. 登入既有 [Cloudflare Worker 首頁](https://threads-scheduler.gogototo24.workers.dev/) 的管理員帳號，無需重新設定 Token。
2. 開啟 `https://threads-scheduler.gogototo24.workers.dev/autopilot`。
3. 填一次系列設定，先保留「啟用」未勾，確認 Master/素材及成本後再開啟。
4. **A 線**：需要已核准 Master 的直接 HTTPS 圖片 URL、角色 ID、題材庫及明確月預算；影片長度 5 秒。
5. **C 線**：需要已授權、可公開讀取的 HTTPS MP4 列表；可選音樂 URL；輸出 30/60/275 秒，由現有 Editor 處理。
6. 系列本身與全域開關分離，避免建立系列就扣幣或在 Threads 公開發布。

### 管理 API

所有變更／私有查詢都需要**既有管理員 Cookie 或 `x-admin-key`**，不允許 P5 Scout 最小權限密鑰修改系列。

- `GET /autopilot`：手機管理頁，未登入自動回首頁。
- `GET /api/factory/autopilot/public`：只讀安全摘要，無 Token。
- `GET /api/factory/autopilot/series`：私人系列設定和最近 40 筆 Run。
- `POST /api/factory/autopilot/series`：新增或更新一個系列；相同 `series_id` 更新設定。

示意的未啟用 C 線配置（**不會自動扣點、生成或發布**）：

```json
{
  "series_id": "catpaw-mv-daily",
  "title": "舞魅喵每日武戲MV",
  "pipeline": "C",
  "universe": "貓掌江湖",
  "schedule_time": "05:50",
  "topic_bank": ["雨夜劍舞・雷痕", "月下獨舞・電弧斬", "一舞封塵・結界破裂"],
  "clip_urls": ["https://YOUR-APPROVED-VIDEO-CLIP-1.mp4"],
  "music_url": "",
  "duration_seconds": 30,
  "estimated_run_twd": 0,
  "monthly_budget_twd": 0,
  "master_approved": false,
  "media_rights_approved": false,
  "cost_approved": false,
  "autopublish": false,
  "enabled": false
}
```

> 示例 URL 並非真正可用的 Master / MP4，不能直接當成正式製片來源。請用真實已核准素材，且不得使用只供登入者瀏覽的 Google Drive 私有分享頁。

## 財務與保護措施

- `CATPAW_AUTOPILOT_ENABLED=true` 啟用**檢查器**，而非強制啟用系列。剛部署無系列，執行 0 次。
- `CATPAW_AUTOPILOT_PAID_ENABLED=false`：A 線不會建立任何 RunningHub 付費任務。必須先在系列核准 `cost_approved` 和每月預算，再由管理者獨立開啟全域付費閘門。
- `FACTORY_PUBLISH_ENABLED=false`：此版本不會自動發布影片。系列 `autopublish` 也必須明確啟用。
- P5 既有 Threads **文字**自動發文、官方消息、Google Trends 與既有五篇 Metricool 排程完全不改。
- 只允許 A/C 線，D 線涉及 Shot 02/03 使用前鏡**真正尾幀**的串接，未達驗收前拒絕導入。B 線不涉及影片發布。
- 需有真實角色 `character_id`、CANON 已核准 Master，禁止依模糊文字替代真實參考圖。
- D1 使用 `series_id:local_day` 去重，避免相同日期多次建立付費生成任務。估算成本**不等於 GPU 實際帳單**；記帳需與 P3 provider 最終資料對帳。
- 影片素材由既有 P3 技術 QA 檢查；若 Meta 無法公開讀取影片 URL，Threads VIDEO 會失敗／進入需處理狀態。
- 不使用 TinyFish、不呼叫 Metricool、不在 GitHub 或 n8n workflow 保存管理密鑰。

## AITuber 對照與目前尚未接線之處

| AITuber 公開功能 | CatPaw Native v1 |
|---|---|
| 每次選新話題 | **題材庫每日輪替**；沒有假裝完成新聞式 AI 自動新劇本 |
| 影片長度與風格 | A 5 秒、C 30/60/275 秒；自訂正史風格 |
| 固定語音與原創配樂 | 保存 voice 設定與可選 C 線 music_url；**尚未自動從劇本產 TTS／配音** |
| Moving AI Images | 尚未接影片 Editor 的圖片 Ken Burns 模式 |
| Full Motion AI Video | A → RunningHub H3 已有 P3 真實 provider |
| Stock Footage | 尚未串素材版權庫，C 線可用使用者已授權現成影片 |
| 自動字幕、封面 | **尚未自動產生及燒錄**；沒有假稱支援 |
| 自動 YouTube / TikTok / Threads | **目前只接既有 Threads VIDEO Publisher**；YouTube、TikTok 需要各自 OAuth／API |
| 點數不足自動暫停 | 系列月預算與全域付費開關可阻止新付費 A 線 |
| 失敗仍保留影片 | P3 真實生成資產和 D1 記錄分離，錯誤保留供查核 |

## 原則

工作流程式與雲端排程具備，不代表某個影片系列已被啟用或真實自動生成。**真正完成指標**為 P3 job ready → QA PASS → Threads VIDEO `published` + 官方 thread ID，之後才回報 permalink。Cloudflare Deploy Success 只代表程式碼已部署。

驗收檔案：
- `tests/factory-autopilot.test.mjs`
- `.github/workflows/validate-catpaw-autopilot.yml`
- `migrations/0016_catpaw_autopilot.sql`

正式發布務必檢查素材 URLs 可由 Threads Meta 服務器匿名讀取、影片長度與實際費用，以及現有 Threads OAuth 狀態。
