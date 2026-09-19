# Threads 自動排程器 v1.0

保留現有 Cloudflare Worker + D1 + Cron + Threads OAuth + 文字發布功能，並新增：

- 文字 + 單張 JPG / PNG 圖片排程
- 台灣時間 Asia/Taipei 自訂時間與快捷時間
- 排程狀態：scheduled / publishing / published / failed
- 顯示排程時間、發布時間、嘗試次數、錯誤訊息
- 自動失敗重試最多 3 次
- 已發布貼文會保存 `thread_id`、`permalink` 與連結
- 支援未發布排程編輯與刪除
- failed 可重新發布
- 圖片儲存在 Cloudflare R2，並透過 `/media/*` 公開給 Threads 讀取
- ADMIN_KEY、Threads Access Token、App Secret 只保留在 Cloudflare Secret / D1，永遠不寫進前端或 GitHub

## 需要設定

1. Cloudflare D1 / R2 binding 已經配置在 `wrangler.toml`。
2. 如需安全存放環境變數，請在 Cloudflare Worker 後台設定：
   - `ADMIN_KEY`
   - `THREADS_APP_SECRET`
3. 如尚未執行 migration，請執行：
   - `npm run db:migrate:remote`
4. 若 D1 不存在，請先建立：
   - `npx wrangler d1 create threads-scheduler-db`
5. 若 R2 bucket 未建立，請先建立：
   - `npx wrangler r2 bucket create threads-scheduler-media`

Meta Threads App 需設定 Redirect URI：
`https://你的-worker網址/auth/callback`

並至少開放：
- `threads_basic`
- `threads_content_publish`

## 重要提醒

- `PUBLIC_BASE_URL` 必須設定成實際 worker 網址，以便圖片和 OAuth callback 正常工作。
- `media_url` 以 Worker `/media/...` 公開，Threads 會讀取該 URL，所以請避免上傳敏感或私人圖片。
- 既有 D1 資料與已發布紀錄會保留，新的 migration 只追加 `permalink` 欄位。
