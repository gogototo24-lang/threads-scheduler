# Threads Scheduler + AI 內容引擎

此專案是《喵台灣》與《貓掌江湖》的內容控制器／排程器，負責話題掃描、草稿、媒體工作、人工審核、排程與 Threads 發布。

## 目前已實作
- `/review`
- `/api/ai/scan`
- `/api/ai/drafts`
- `media_jobs`：pending / generating / completed / failed
- 文字 provider：mock / OpenAI
- 圖片 provider：mock / OpenAI
- 影片 provider：mock / PixVerse
- D1：trends / content_drafts / media_jobs / posts
- R2：生成媒體
- Cron：排程發布與媒體工作

## 推薦串聯

```text
題材
→ OpenAI 草稿
→ video-prompt-builder
→ 首幀
→ PixVerse 或 Higgsfield Seedance 2.5
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
```

正式環境使用 Cloudflare Secrets 保存 API Key。

## 目前重要限制

1. 影片生成工作已存在，但正式 Threads publisher 目前只完整處理 TEXT / IMAGE。
2. Higgsfield Seedance 2.5 尚未實作成 Worker provider。
3. VIDEO 發布在再次核實 Threads 官方 API 前不直接修改 production code。

## 升級狀態

`package-lock.json` 已鎖 Wrangler 4.135.0，這一項目前不需要升級。

## 安全

- API Key、Threads token、Admin key 不提交 Git。
- 新 provider 先在 mock / staging 測通，再切正式環境。
