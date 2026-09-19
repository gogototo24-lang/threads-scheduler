# AI 自動內容引擎增量功能

已在既有 Worker 外加可替換 provider 與人工審核流程，預設不呼叫任何付費 AI API：

- `/review`：待審核內容頁面
- 每次 mock 掃描產生 4 個來源話題、每個話題 2 個宇宙草稿（共 8 個）
- 保存來源 URL、來源名稱、抓取時間、摘要、文案、視覺提示詞與建議發布時間
- `media_jobs` 狀態：pending / generating / completed / failed
- AI 圖片預覽使用 mock SVG；影片使用 mock placeholder，不會產生付費費用
- 只有按下「核准並排程」才會寫入既有 `posts` 表，沿用原有 Threads scheduler
- 政治／公共事務關鍵字只產生中性摘要與創意視覺概念
- 每分鐘 Cron 保留原有排程發布，並處理 media jobs；距離上次掃描一小時以上時自動掃描

## 新增 migration

```bash
npm run db:migrate:remote
```

`0003_ai_content_engine.sql` 新增 `trends`、`content_drafts`、`media_jobs`，不會修改或刪除既有 `posts`、`settings` 或已發布資料。

## Worker Secrets

目前 mock 模式不需要新增 secret。未來啟用 provider 時，建議使用：

- `AI_SEARCH_API_KEY`
- `AI_TEXT_API_KEY`
- `AI_IMAGE_API_KEY`
- `AI_VIDEO_API_KEY`

Provider 名稱透過非敏感的 `AI_*_PROVIDER` vars 設定，API key 只放 Cloudflare Worker Secrets。實際 provider 仍需依供應商 API 規格在 `src/ai-engine.js` 實作。

## 需要手動申請／設定的 API

目前沒有，因為預設是 mock。正式使用時才需要依選定供應商申請搜尋、文字、圖片與影片 API，並確認授權條款與來源引用要求。

## 可能產生費用的服務

- 外部新聞／社群搜尋 API：依查詢次數或流量計費
- 文字模型 API：依 input/output tokens 計費
- 圖片生成 API：依圖片張數、解析度計費
- 影片生成 API（例如後續 PixVerse 或其他 provider）：通常依秒數、解析度或點數計費
- Cloudflare Workers、D1、R2：依帳戶方案、請求量、儲存量與流量計費；mock 不會呼叫上述 AI 供應商
