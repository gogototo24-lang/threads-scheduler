# CatPaw P5｜海巡爆點快速發布修復（2026-10-21）

## 問題背景

過去「Worker Ready」只證明程式與 D1 可回應。海巡 AI 若使用
\`GET /api/factory/p5/actions\` 等 ADMIN_KEY 端點卻沒有 \`ADMIN_KEY\`，
將得到 HTTP 401。這不是新聞審核失敗，更不是 Threads 已成功發佈。

另外舊 P5 的 \`original_post\` 回傳經常缺 permalink；多個 Cron 或總控
同時碰到同一個 queued action，有重複發文的風險。

## 新方案（無需公開 ADMIN_KEY）

**所有新內容正式發布路徑：CatPaw Worker → Threads 官方 API。**
既有五篇使用者已審核且排程的 Metricool 貼文原樣保留，不遷移、不重發。
不建立任何新的 Metricool 任務，不發私訊。

1. 海巡 AI 根據可信來源核實事件並準備原創短文。
2. 可信任的外部服務使用 **專用 \`P5_SCOUT_KEY\`**（Cloudflare Worker secret）
   呼叫 \`POST /api/factory/p5/fastlane\`。
3. Worker 檢查僅允許非政治分類、有來源網址、原創文案、最近 2 小時核實紀錄、
   不包含未授權媒體。舊高風險資料不走快車道。
4. D1 用來源 URL 的 SHA-256 對應固定 action ID，重送也只寫一次。
5. Worker 限流並立即嘗試 Threads 官方 API，將結果寫成
   \`queued\` / \`sending\` / \`sent\` / \`blocked_auth\` / \`publish_unknown\`。
   **僅收到官方 thread ID 才認定 sent；公開 permalink 另外讀回**。
6. \`publish_unknown\`（網路失敗無法確認是否發文）永不自動重送，須人工查證。

## 對外 API

- \`GET /api/factory/p5/fastlane/health\`
- \`POST /api/factory/p5/fastlane\`
- \`GET /api/factory/p5/fastlane/actions/:id\`

全部必須 \`x-p5-scout-key\` 或既有 admin session／key 驗證。
\`health\` 只顯示 secret 是否配置和 D1 狀態，絕不顯示密碼/token。
\`threads_token_stored=true\` **不代表** OAuth 仍有效（真正 API 請求才能確定）。

範例（示意，勿貼真正密鑰到公開 GitHub／聊天內容）：

\`\`\`bash
curl -X POST "https://threads-scheduler.gogototo24.workers.dev/api/factory/p5/fastlane" \
  -H "content-type: application/json" \
  -H "x-p5-scout-key: $P5_SCOUT_KEY" \
  --data '{
    "title": "今晚藝文活動預告",
    "category": "entertainment",
    "source_url": "https://example.com/official-event",
    "verified_at": "2026-10-21T02:00:00Z",
    "verification_method": "official",
    "verification_urls": ["https://example.com/official-event"],
    "text": "今晚有特別的地方文化活動，大家會出門嗎？最新安排以官方公告為準。來源：https://example.com/official-event",
    "contains_unlicensed_media": false
  }'
\`\`\`

示範用 URL 是佔位符，不能直接當作真實新聞發布。

## 一次性管理員操作（部署後）

1. 開啟 Cloudflare Worker \`threads-scheduler\` → Settings → Variables and Secrets。
2. 新增 / 驗證 secret \`P5_SCOUT_KEY\`。若原本已設定，請不要任意重置，以免現有可信端失效。
3. 在**可信任**的海巡執行環境配置相同的專用 scout secret。切勿把
   \`ADMIN_KEY\` 提供給 AI 工人／公眾，或將任何 Key 放在 GitHub 靜態頁 JS。
4. 確認 Threads OAuth 已連接並獲得 \`threads_content_publish\` 授權；
   Worker \`settings.threads_access_token\` 有值不等於 token 有效。
5. 先呼叫 \`/fastlane/health\`，接著提交**不會造成真實發文**的隔離測試或 staging Mock
   驗證身份；首次真實發布須另外執行單筆端到端並取得 thread ID/permalink。
6. ChatGPT 內建的自動化排程若沒有獲准的外部 HTTP/connector 與服務密鑰，
   **無法直接呼叫受保護的 Worker**；需配置可信的中介執行環境。
   不能將 \`Ready\` 或 D1 入列當作發布成功。
7. 如果無法連線，海巡應優先直接通知使用者**可複製的及時貼文**和來源，
   不要等候不會成功的重試，也不要降級到 Metricool。

## 回報格式

每個任務必須有：
\`action_id\`, \`status\`, \`thread_id\`, \`permalink\`, \`sent_at\`, \`error\`。

- \`sent + thread_id\`：Threads API 已接受發布；若尚無 permalink，報告「已發布，連結待取」。
- \`queued\`：僅入列，還未發布。
- \`blocked_auth\`：缺少 Threads OAuth token，需管理員授權。
- \`publish_unknown\`：外部 API 回應不明，先查證再處理，禁止自動重發。
- HTTP 401：登入/服務秘密未通過，**不是** Threads 發布結果。

## 安全與限制

驗證資料屬已授權海巡提供的聲明，Worker **不自行再次網路查核公告真假**；
因此初次啟用快車道前，要確定海巡來源核實程序可靠。
真正的政治／選舉／傷亡／侵犯他人及版權問題仍待人工審核。
即使最快的執行成功，仍可能遇到 Threads API 故障、發文限額或媒體限制。
