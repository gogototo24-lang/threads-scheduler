# Threads 自動排程器 v0.1

個人用 Threads 排程 Web App。支援：

- 文字貼文
- 單張圖片 + 文字
- 指定日期與時間自動發布
- 立即發布
- 排程列表 / 成功 / 失敗狀態
- 失敗最多自動重試 3 次
- Threads OAuth 連線
- Long-lived token 自動刷新
- 圖片存放於 Cloudflare R2，Threads 可直接抓取
- Token 與 App Secret 只留在伺服器端，不寫進瀏覽器程式碼

## 架構

- Cloudflare Worker：網頁、API、排程工作、Threads API 呼叫
- Cloudflare D1：排程資料與 Threads token
- Cloudflare R2：圖片
- Cron Trigger：每分鐘檢查一次到期貼文

## 需要準備

1. Cloudflare 帳號
2. Meta Developer Threads App
3. Threads App ID
4. Threads App Secret
5. Meta 端允許的 Redirect URL

> 請依 Meta 的實際帳號與年齡/資格規則申請，不要繞過任何年齡或身分限制。

## 部署步驟

### 1. 安裝

```bash
npm install
npx wrangler login
```

### 2. 建立 D1

```bash
npx wrangler d1 create threads-scheduler-db
```

把輸出的 `database_id` 填進 `wrangler.toml`。

### 3. 建立 R2

```bash
npx wrangler r2 bucket create threads-scheduler-media
```

### 4. 建立設定檔

將 `wrangler.toml.example` 複製成 `wrangler.toml`，填入：

- `THREADS_APP_ID`
- D1 database id
- 部署後再填 `PUBLIC_BASE_URL`

### 5. 設定密鑰

```bash
npx wrangler secret put THREADS_APP_SECRET
npx wrangler secret put ADMIN_KEY
```

`ADMIN_KEY` 是你自己設定的管理密碼，請用至少 16 個字元。

### 6. 套用資料庫 migration

```bash
npm run db:migrate:remote
```

### 7. 第一次部署

```bash
npm run deploy
```

Cloudflare 會給你類似：

`https://threads-scheduler.xxx.workers.dev`

把這個網址填回 `wrangler.toml` 的 `PUBLIC_BASE_URL`，再部署一次。

### 8. Meta Threads App 設定 Redirect URL

在 Meta Developer 後台把 OAuth Redirect URL 設成：

`https://你的-worker網址/auth/callback`

並使用至少這兩個權限：

- `threads_basic`
- `threads_content_publish`

### 9. 打開網站

輸入你設定的 `ADMIN_KEY`，按「連接 Threads」，完成授權。

## 使用方式

1. 輸入貼文文字
2. 可選擇一張圖片
3. 選擇排程時間
4. 按「加入排程」
5. Worker 每分鐘會自動檢查並發布

## 安全注意

- `THREADS_APP_SECRET` 與 `ADMIN_KEY` 使用 Cloudflare Secret，不要提交到 GitHub。
- Threads token 儲存在 D1，僅 Worker 端可讀取。
- `/media/*` 為公開網址，這是 Threads API 取得圖片所需；請勿上傳私人或敏感圖片。
- 這個 v0.1 是單一使用者工具，不適合作為多人 SaaS。

## v0.2 可加

- 多圖輪播
- 影片
- 草稿分類
- 每週排程日曆
- 自動產生 Hashtag / 文案模板
- 發文後自動取得 permalink
- Insights 成效統計
- 多 Threads 帳號
