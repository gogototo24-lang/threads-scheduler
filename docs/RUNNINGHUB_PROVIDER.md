# RunningHub 低成本測片 Provider

更新：2026-10-08

## 目的

把《貓掌江湖／喵台灣》的影片流程改成：

```text
Storyboard / visual prompt
→ 首幀
→ RunningHub 低成本 AI App 測片
→ 審核
→ 只把好的版本進一步升畫質／做 MV
```

這個 provider **預設不啟用**。沒有 API Key、WebApp ID、nodeInfoList 時不會送出任何付費任務。

## 官方 API 流程

1. 上傳首幀：`POST /task/openapi/upload`
2. 建立 AI App 任務：`POST /task/openapi/ai-app/run`
3. 取得 `taskId`
4. 查詢輸出：`POST /task/openapi/outputs`
5. 輸出完成後取得 `fileUrl`
6. Worker 下載 MP4 到 R2
7. 審核頁顯示 RunningHub 的 `taskCostTime`

> RunningHub 官方文件指出 AI App API 可使用 Consumer-Member API Key；Workflow / AI App 都採 taskId 非同步流程。

## Secret

API Key **只能**放 Cloudflare Worker Secret：

```bash
npx wrangler secret put RUNNINGHUB_API_KEY
```

不要把 API Key 寫進 `wrangler.toml`、GitHub、HTML 或聊天截圖。

## 非敏感設定

`wrangler.toml`：

```toml
AI_VIDEO_PROVIDER = "mock"

RUNNINGHUB_API_BASE_URL = "https://www.runninghub.ai"
RUNNINGHUB_VIDEO_WEBAPP_ID = ""
RUNNINGHUB_VIDEO_NODE_INFO_JSON = ""
RUNNINGHUB_VIDEO_DURATION = "5"
RUNNINGHUB_VIDEO_ASPECT_RATIO = "9:16"
RUNNINGHUB_EST_NTD_PER_GPU_MIN = "0"
```

### 啟用前需要兩樣資料

1. `RUNNINGHUB_VIDEO_WEBAPP_ID`  
   你選定的「低成本圖生影片 AI App」ID。

2. `RUNNINGHUB_VIDEO_NODE_INFO_JSON`  
   從該 AI App 的 API Call / node info 複製欄位結構，並把需要動態替換的位置改成 placeholder。

範例：

```json
[
  {
    "nodeId": "10",
    "fieldName": "image",
    "fieldValue": "{{IMAGE}}"
  },
  {
    "nodeId": "11",
    "fieldName": "text",
    "fieldValue": "{{PROMPT}}"
  },
  {
    "nodeId": "12",
    "fieldName": "duration",
    "fieldValue": "{{DURATION}}"
  },
  {
    "nodeId": "13",
    "fieldName": "aspect_ratio",
    "fieldValue": "{{ASPECT_RATIO}}"
  }
]
```

支援的 placeholder：

- `{{IMAGE}}`：Worker 上傳首幀後取得的 RunningHub fileName
- `{{PROMPT}}`：media job 的影片提示詞
- `{{DURATION}}`：預設 5 秒
- `{{ASPECT_RATIO}}`：預設 9:16

**nodeId / fieldName 必須以你選定的 AI App 實際資料為準，不能照抄範例。**

## 低成本策略

第一階段建議固定：

- 5 秒
- 9:16
- 測試解析度／快速模型
- 一次只跑已通過首幀審核的候選
- 不在失敗時自動無限重跑
- 最終發布版才升畫質或進 AI Music Studio v2 合成 MV

## 成本資訊

RunningHub outputs 若包含：

```json
{
  "taskCostTime": "35"
}
```

系統會記錄為：

- 任務／GPU 時間：約 35 秒
- 若設定 `RUNNINGHUB_EST_NTD_PER_GPU_MIN`，審核頁額外顯示估算台幣成本

這只是**估算**，實際扣款以 RunningHub Tasks & Billing 為準；第三方 API 節點也可能另外收費。

## 正式切換

完成一個 AI App 的 node mapping 並測通後，才把：

```toml
AI_VIDEO_PROVIDER = "runninghub"
```

在此之前維持 `mock` 或 `pixverse`。

## 回退

若 RunningHub 發生錯誤，可立即改回：

```toml
AI_VIDEO_PROVIDER = "pixverse"
```

或：

```toml
AI_VIDEO_PROVIDER = "mock"
```

不需修改其他工作流。
