# Threads Scheduler + AI 內容引擎

此專案是《喵台灣》與《貓掌江湖》的內容控制器／排程器，負責話題掃描、草稿、媒體工作、人工審核、排程與 Threads 發布。

## 目前已實作
- `/review`
- `/api/ai/scan`
- `/api/ai/drafts`
- `media_jobs`：pending / generating / completed / failed
- 文字 provider：mock / OpenAI
- 圖片 provider：mock / OpenAI
- 影片 provider：mock / PixVerse / RunningHub AI App
- D1：trends / content_drafts / media_jobs / posts
- R2：生成媒體
- Cron：排程發布與媒體工作

## 推薦串聯

```text
題材
→ OpenAI 草稿
→ video-prompt-builder
→ 首幀
→ RunningHub 低成本測片 / PixVerse / Higgsfield Seedance 2.5
→ AI Music Studio v2
→ /review
→ Threads 排程
```

## 兩個宇宙規則

### 貓掌江湖
- 9:16
- 全角色維持母喵設定
- 電影級布袋戲武俠視覺
- 強調角色一致性、招式節奏、首尾幀連續
- 非血腥呈現

### 喵台灣
- 直式社群圖／短片
- 優先生活、交通、科技、節慶與可視覺化題材
- 公共事務內容維持事實核實與中立表述

## Provider 設定

非敏感設定放 `wrangler.toml`：

```toml
AI_SEARCH_PROVIDER = "mock"
AI_TEXT_PROVIDER = "mock"
AI_IMAGE_PROVIDER = "mock"
AI_VIDEO_PROVIDER = "mock"

# RunningHub 只有在正式測通後才切：
# AI_VIDEO_PROVIDER = "runninghub"
```

正式環境使用 Cloudflare Secrets 保存 API Key。

## RunningHub 低成本測片

已完成 RunningHub AI App provider adapter：

- 上傳已核准首幀
- 建立 RunningHub `taskId`
- 輪詢 `/task/openapi/outputs`
- 完成後下載 MP4 到 R2
- 審核頁記錄 `taskCostTime`
- 可選填每 GPU 分鐘台幣估值，顯示估算成本
- 預設仍為 `mock`，不會自動扣點

正式啟用前必須設定：
- Worker Secret：`RUNNINGHUB_API_KEY`
- `RUNNINGHUB_VIDEO_WEBAPP_ID`
- `RUNNINGHUB_VIDEO_NODE_INFO_JSON`

完整說明：`docs/RUNNINGHUB_PROVIDER.md`

## 目前重要限制

1. 影片生成工作已存在，但正式 Threads publisher 目前只完整處理 TEXT / IMAGE。
2. Higgsfield Seedance 2.5 尚未實作成 Worker provider。
3. VIDEO 發布在再次核實 Threads 官方 API 前不直接修改 production code。

## 升級狀態

`package-lock.json` 已鎖 Wrangler 4.135.0，這一項目前不需要升級。

## 安全

- API Key、Threads token、Admin key 不提交 Git。
- 新 provider 先在 mock / staging 測通，再切正式環境。
