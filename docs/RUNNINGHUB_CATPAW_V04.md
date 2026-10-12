# CatPaw AI Factory v0.4 — RunningHub H3 自動化規格

## 目標

把 RunningHub 定位為 GPU Worker，只負責 MiniMax H3 生成；提示詞、成本閘門、排程、審核與發布由 CatPaw Factory / n8n 控制。

## 已確認的原始 H3 API 節點

- Prompt: node 234 / field `value`
- Duration: node 236 / field `value`
- Aspect ratio: node 235 / field `aspect_ratio`
- Megapixels: node 235 / field `megapixels`
- Steps: node 224 / field `steps`
- Seed: node 222 / field `noise_seed`
- Save video: node 228
- H3 conditioning: node 225 `MiniMaxH3ReferenceToVideo`

原始 API JSON 的 node 225 沒有 ref_images/ref_videos/ref_audios 連線，因此文字中的 `@圖片1` 不能視為真正的角色參考圖輸入。

## Live workflow 必做修改

1. 在 RunningHub 副本加入可由 API 修改的 `LoadImage` 或 `LoadImageFromUrl` 節點。
2. 將該圖片節點真正接入 node 225 的 reference image 輸入。
3. 重新 Export Workflow API，確認 API JSON 裡 node 225 已出現 reference image connection。
4. AI App / WebApp 需把以下欄位暴露為可修改 input：
   - 參考圖
   - Prompt
   - Duration
   - Aspect ratio
   - Megapixels（建議暴露）
   - Steps（建議暴露）
   - Seed（建議暴露）
5. 由 AI App 的 node info 讀取 9:16 LIST 的精確 option 字串，不手動猜字串。

## nodeInfoList template

把 `<LOAD_IMAGE_NODE_ID>` 換成重新匯出後真正的圖片節點 ID。

```json
[
  {"nodeId":"<LOAD_IMAGE_NODE_ID>","fieldName":"image","fieldValue":"{{IMAGE}}"},
  {"nodeId":"234","fieldName":"value","fieldValue":"{{PROMPT}}"},
  {"nodeId":"236","fieldName":"value","fieldValue":"{{DURATION}}"},
  {"nodeId":"235","fieldName":"aspect_ratio","fieldValue":"{{ASPECT_RATIO}}"},
  {"nodeId":"235","fieldName":"megapixels","fieldValue":"{{MEGAPIXELS}}"},
  {"nodeId":"224","fieldName":"steps","fieldValue":"{{STEPS}}"},
  {"nodeId":"222","fieldName":"noise_seed","fieldValue":"{{SEED}}"}
]
```

## 建議生成策略

### Preview
- 5 秒
- 0.4 MP
- 24 steps
- 固定 seed
- 只測角色、動作方向、鏡頭與 reference image binding

### Production
- 15 秒
- 0.4 MP 起跑；確認 VRAM/成本後才試 0.6 MP
- 24 steps
- 保持 multiple=32
- 9:16
- 同一角色在 A/B test 時可固定 seed；正式多支影片可由控制層指定 seed

## 武戲提示詞策略

提示詞在 n8n/Factory 生成後直接注入 node 234，不依賴 node 229/230/231 的文字模板節點。

貓掌江湖武戲 prompt 必須包含：
- 前 0.5–1.0 秒立即發生有效動作
- 明確「起手 → 接觸/施法 → 受力或環境反應 → 下一招」
- 主角身份、服裝、武器、母喵設定鎖定
- feline paws / no human fingers / no extra limbs
- 鏡頭在接觸、遮擋、落地、破障處切換
- 最後 1–2 秒保留反轉或懸念

## Controller 安全規則

- `FACTORY_LIVE_ENABLED=false` 預設保持鎖定
- `FACTORY_PUBLISH_ENABLED=false`
- P2 只允許 pipeline A / RunningHub / 5 秒 / 單任務
- node map 必須同時有 IMAGE / PROMPT / DURATION / ASPECT_RATIO 四個綁定
- 上傳素材超過 30MB 時拒絕
- 任務超過設定 timeout 後停止本地輪詢
- 中間輸出不是 mp4 時維持 generating，不誤判 failed
- 不自動重送失敗的付費 GPU 任務
