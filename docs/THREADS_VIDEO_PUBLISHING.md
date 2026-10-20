# Threads 影片發布修補（隔離測試版）

本修補只擴充 **Cloudflare Worker \`threads-scheduler\` → Threads 官方 API**，不使用 Metricool，也不會在合併或執行單元測試時直接發文。

## 新能力

- 管理頁以及經 ADMIN_KEY 授權的 \`POST /api/posts\`（\`multipart/form-data\`）新增欄位 \`video\`，單支 \`video/mp4\`、最多 **25 MB**。與 \`image\` 二擇一。
- 驗證 MP4 \`ftyp\` 檔頭後，以串流存至既有 Cloudflare R2 \`MEDIA\`，生成 HTTPS 公開媒體網址。
- 公開 \`GET /media/{key}\`、\`HEAD /media/{key}\` 和 Range bytes；Meta 伺服器必須能匿名抓取原始 MP4。
- 排程啟動後先建立 Threads VIDEO 容器，狀態轉 \`processing\`；每分鐘由 Worker Cron 檢查，容器回報 \`FINISHED\` 才呼叫 \`threads_publish\`。
- D1 新增容器 ID、開始處理時間、下次輪詢時間、發布請求時間，降低重複請求風險。
- 若發布 POST 回應不明，記錄 \`publish_unknown\`，**不可自動重試**。應先在 Threads 帳號查證有無成功發布。
- 舊的 TEXT/IMAGE 排程路徑保留不變，P5 私訊禁令與政治審核規則也未變更。

## 部署前提

1. GitHub PR 上的離線測試、JavaScript 語法檢查及 Wrangler dry-run 全部通過。
2. 先套用 \`migrations/0011_threads_video.sql\`，再部署更新後的 Worker（既有 GitHub Deploy 工作流已採 migrations → deploy 順序）。
3. 確認 R2 \`MEDIA\` 已綁定，\`PUBLIC_BASE_URL\` 指向可從網路存取的正式 HTTPS Worker，\`GET\`/ \`HEAD\`/Range 對外有效。
4. 以管理員身分查看 \`/api/status\`，確認已連接**正確** Threads 帳號、Token 未過期且 OAuth scope 包含 \`threads_content_publish\`。API 顯示 connected 只代表本地憑證存在，不等於外部有效。
5. 正式測試應用明確核准的測試貼文，**本次《留言區風暴》由使用者自行手動發布**，不由修補流程上傳發布。

## 非發布煙霧測試

- 在管理頁新增一筆**將來時間**的測試影片排程，不按「立即發布」。
- 管理員讀取 \`GET /api/posts\`，確認 \`media_type=VIDEO\` 且 \`status=scheduled\`。
- 使用公開 HTTPS \`media_url\` 檢查 \`HEAD\` 回應 \`content-type: video/mp4\`、\`content-length\`，\`GET\` 回應 200，帶 \`Range: bytes=0-1023\` 回應 206。
- 完成檢查後刪除該筆**尚未到期**的測試排程，確認影片不會自行發文。
- 生產首次實際影片發文需另外授權與小範圍驗收，不用既有五筆 Metricool 貼文進行測試。

## 注意事項

- 自動輪詢採每分鐘 Cron，一次最多檢查五筆 VIDEO；Meta 的處理時間不保證固定。
- \`processing\`／\`publishing\`／\`publish_unknown\` 不可以直接在管理頁修改、刪除或重試，避免重複貼文。
- 發布成功但讀取公開 permalink 暫時失敗時，資料庫仍可有官方 thread ID、permalink 暫為 NULL；不得自行構造冒充已核實的網址。
- MP4 容器驗證不代表編碼完全正確。正式提交前應由影片 QA 確認 H.264、AAC（若有音訊）、畫面比例與實際播放能力。
- 此修補是 Threads \`posts\` 排程器的影片流程；P5 海巡原創內容仍應遵照原有的安全審核、去重和速率限制。

參考：Meta 官方 Threads Postman API Collection（Video Container, Publishing Status, Publish）。
