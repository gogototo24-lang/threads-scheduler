# P5 24H 海巡｜Cloudflare 原生官方來源自動發布 v1

## 這次真正完成的部分

使用既有 Cloudflare Worker Cron（每分鐘），每 10 分鐘至多跑一次官方來源掃描。
第一批已確認具有官方 XML/RSS 來源的服務為**文化部文化新聞**：

https://www.moc.gov.tw/OpenData.aspx?SN=C4E4E3A8E687AD91

執行流程：

1. Worker Cron 獨立啟動官方來源掃描，不受舊 AI_SEARCH_PROVIDER=mock 影響。
2. 從官方 RSS 取得候選，僅處理發布 90 分鐘內、與藝文內容相關的消息。
3. 排除選舉、政策、傷亡、爭議與其他敏感字樣；內容必須符合官方來源 allowlist。
4. 再次確認官方文章可讀取，且最後網址仍在文化部網域。
5. 套用固定、原創、含來源網址的喵台灣貼文模板（**不複製來源圖片，不編造事件細節**）。
6. 交給原有 P5 fastlane，使用 D1 source URL 去重，發布前原子鎖定。
7. 僅由 threads-scheduler → Threads 官方 API 發文；有官方 thread ID 時記錄為 sent，額外讀回 permalink。
8. 回傳並記錄本輪 scanned／eligible／published／error，避免假稱已發。

每輪最多發布一則；固定時段去重，每小時上限仍受既有設定限制。
本次不用 n8n，避免原先 ChatGPT 排程與 n8n 之間沒有推送機制的授權問題。

## 監控

管理員已登入 Worker 後，可讀取：

`GET https://threads-scheduler.gogototo24.workers.dev/api/factory/p5/official-scout/status`

這是唯讀介面，回傳最新 10 分鐘週期的真實狀態，包含結果與已確認公開連結。

## 不能混淆的邊界

- **這不是全網爆點雷達**。目前僅官方文化新聞源，捕捉台灣娛樂與熱門社群討論仍需要另行部署更多合規可靠的來源或實際海巡代理。
- 它是正式執行路徑，不是三節點授權 Mock；但資料源可能沒有新消息。沒有新消息時結果應為 no_fresh，不應硬編造或發布。
- 當 `FACTORY_P5_OFFICIAL_SCOUT_ENABLED=true` 且既有 `FACTORY_P5_AUTO_SEND=true`、`FACTORY_P5_ALLOW_EXTERNAL_PUBLISH=true` 時，正式 Worker 的定時任務**有權發文**。使用者已授權低風險非政治新聞自動發布。
- 舊的 AI_SEARCH_PROVIDER 等生成工具仍然在 mock，不代表有廣泛自動 AI 創作。
- 沒有立即發文不等於故障，應看最新 run.status 與 error。
- 只有 source URL 變體去重；跨平台、同一新聞不同網址的語意去重尚未完善，不應誇稱能百分百避免撞題。
- 不發布政治、高風險、來源不明、第三方圖片、私訊；舊有已核准 Metricool 五篇保留，不會新增 Metricool 排程。
- 使用官方 RSS 可能有延遲或網站拒絕抓取；部署後應檢查第一次記錄，不能從離線測試推論真實發文成功。

## 恢復或緊急關閉

Cloudflare Worker → Settings → Variables and Secrets：

將 `FACTORY_P5_OFFICIAL_SCOUT_ENABLED` 設為 `false`，部署後停止**官方來源**自動海巡發布，不影響 P5 現有其他路徑與舊排程。

不要刪除 ADMIN_KEY 或 Threads OAuth。登入與憑證問題和內容來源掃描是兩種不同問題。

## 代碼測試

`node --test tests/p5-official-autoscout.test.mjs`

涵蓋真實部署前的模擬 RSS、政治過濾、過期過濾、網域 allowlist、單筆 TEXT 容器與發布、回讀 permalink、佇列去重、來源故障不發文。
