const TZ = 'Asia/Taipei';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';

export function providers(env) {
  return { search: env.AI_SEARCH_PROVIDER || 'mock', text: env.AI_TEXT_PROVIDER || 'mock', image: env.AI_IMAGE_PROVIDER || 'mock', video: env.AI_VIDEO_PROVIDER || 'mock' };
}

export async function searchTrends(env) {
  const provider = providers(env).search;
  if (provider === 'mock') return mockTrends();
  if (provider === 'openai') return openAiSearch(env);
  throw new Error(`不支援的搜尋 provider：${provider}`);
}

export async function generateDrafts(env, trend) {
  const provider = providers(env).text;
  if (provider === 'mock') return mockDrafts(trend);
  if (provider === 'openai') return openAiDrafts(env, trend);
  throw new Error(`不支援的文字 provider：${provider}`);
}

export async function generateImage(env, job, draft = null) {
  const provider = providers(env).image;
  if (provider === 'mock') return mockImage(job);
  if (provider === 'openai') return openAiImage(env, job, draft);
  throw new Error(`不支援的圖片 provider：${provider}`);
}

export async function startVideo(env, job, draft, image) {
  const provider = providers(env).video;
  if (provider === 'mock') return { kind: 'completed', result: mockVideo(job) };
  if (provider === 'pixverse') return pixverseStart(env, job, draft, image);
  throw new Error(`不支援的影片 provider：${provider}`);
}

export async function pollVideo(env, job) {
  if (providers(env).video !== 'pixverse') throw new Error(`不支援的影片 provider：${providers(env).video}`);
  return pixversePoll(env, job);
}

async function openAiSearch(env) {
  requireSecret(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
  const response = await openAiRequest(env, { model: env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini', tools: [{ type: 'web_search' }], input: '請搜尋台灣最近 24 小時內的熱門新聞、生活、交通、科技、節慶與社群話題。只回傳 JSON 陣列，最多 5 筆、至少 3 筆。每筆欄位為 title、summary、source_url、source_name、content_type。' });
  const fetchedAt = new Date().toISOString();
  return parseJsonArray(response).slice(0, 5).filter((x) => x.title && x.summary && validUrl(x.source_url)).map((x) => ({ title: String(x.title).slice(0, 240), summary: String(x.summary).slice(0, 1200), source_url: x.source_url, source_name: String(x.source_name || new URL(x.source_url).hostname).slice(0, 160), content_type: x.content_type || 'text', fetched_at: fetchedAt }));
}

async function openAiDrafts(env, trend) {
  requireSecret(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
  const response = await openAiRequest(env, { model: env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini', input: `根據以下有來源的台灣話題，為「喵台灣宇宙」與「貓掌江湖」各產生一份繁體中文 Threads 草稿。只回傳 JSON 陣列，每筆包含 universe、title、copy、visual_prompt、suggested_at。話題：${JSON.stringify(trend)}` });
  const result = parseJsonArray(response);
  return ['喵台灣宇宙', '貓掌江湖'].map((universe) => { const found = result.find((x) => x.universe === universe) || {}; return { universe, title: String(found.title || `${universe}｜${trend.title}`), summary: trend.summary, copy: String(found.copy || `【${universe}】${trend.title}\n${trend.summary}\n（AI 草稿，發布前請人工審核）`), visual_prompt: String(found.visual_prompt || defaultPrompt(universe, trend.title)), suggested_at: validDate(found.suggested_at) ? found.suggested_at : new Date(Date.now() + 3600000).toISOString() }; });
}

async function openAiImage(env, job, draft) {
  requireSecret(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
  const style = draft?.universe === '貓掌江湖' ? '9:16 電影級布袋戲母喵武俠視覺，所有貓角色都是母喵' : '直式社群梗圖與電影海報感的喵台灣視覺';
  const response = await fetch(OPENAI_IMAGES_URL, { method: 'POST', headers: authHeaders(env.OPENAI_API_KEY, 'application/json'), body: JSON.stringify({ model: env.OPENAI_IMAGE_MODEL || 'gpt-image-2', size: '1024x1536', quality: env.OPENAI_IMAGE_QUALITY || 'auto', prompt: `${style}。${job.input_prompt}。繁體中文語境，請勿產生難以辨識的文字。` }) });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error?.message || 'OpenAI 圖片生成失敗');
  const item = data?.data?.[0];
  if (item?.b64_json) return { body: base64ToBytes(item.b64_json), contentType: 'image/png' };
  if (!item?.url) throw new Error('OpenAI 未回傳圖片');
  const image = await fetch(item.url); if (!image.ok) throw new Error('OpenAI 圖片下載失敗');
  return { body: image.body, contentType: image.headers.get('content-type') || 'image/png' };
}

async function pixverseStart(env, job, draft, image) {
  requireSecret(env.PIXVERSE_API_KEY, 'PIXVERSE_API_KEY');
  if (!image?.url) throw new Error('請先生成圖片');
  const base = (env.PIXVERSE_API_BASE_URL || 'https://app-api.pixverse.ai/openapi/v2').replace(/\/$/, '');
  const source = await fetch(image.url); if (!source.ok) throw new Error('PixVerse 圖片下載失敗');
  const form = new FormData(); form.append('image', new Blob([await source.arrayBuffer()], { type: source.headers.get('content-type') || 'image/png' }), 'image.png');
  const uploaded = await fetch(`${base}/image/upload`, { method: 'POST', headers: { 'API-KEY': env.PIXVERSE_API_KEY, 'Ai-trace-id': crypto.randomUUID() }, body: form });
  const uploadJson = await readJson(uploaded); const imgId = uploadJson?.Resp?.img_id;
  if (!uploaded.ok || !imgId) throw new Error(uploadJson?.ErrMsg || 'PixVerse 圖片上傳失敗');
  const created = await fetch(`${base}/video/img/generate`, { method: 'POST', headers: { 'API-KEY': env.PIXVERSE_API_KEY, 'Ai-trace-id': crypto.randomUUID(), 'Content-Type': 'application/json' }, body: JSON.stringify({ img_id: imgId, prompt: job.input_prompt || draft?.visual_prompt || '', model: 'v6', duration: 5, quality: '720p' }) });
  const createdJson = await readJson(created); const videoId = createdJson?.Resp?.video_id;
  if (!created.ok || !videoId) throw new Error(createdJson?.ErrMsg || 'PixVerse 影片建立失敗');
  return { kind: 'pending', providerJobId: String(videoId) };
}

async function pixversePoll(env, job) {
  const base = (env.PIXVERSE_API_BASE_URL || 'https://app-api.pixverse.ai/openapi/v2').replace(/\/$/, '');
  const response = await fetch(`${base}/video/result/${encodeURIComponent(job.provider_job_id)}`, { headers: { 'API-KEY': env.PIXVERSE_API_KEY, 'Ai-trace-id': crypto.randomUUID() } });
  const data = await readJson(response); if (!response.ok) throw new Error(data?.ErrMsg || 'PixVerse 狀態查詢失敗');
  const result = data?.Resp || {}; const status = Number(result.status);
  if (status === 1) return { status: 'completed', url: result.url };
  if (status === 5) return { status: 'generating' };
  if (status === 7 || status === 8) return { status: 'failed', error: result.message || result.error || `PixVerse 影片狀態：${status}` };
  return { status: 'generating' };
}

async function openAiRequest(env, body) { const response = await fetch(OPENAI_RESPONSES_URL, { method: 'POST', headers: authHeaders(env.OPENAI_API_KEY, 'application/json'), body: JSON.stringify(body) }); const data = await readJson(response); if (!response.ok) throw new Error(data?.error?.message || 'OpenAI Responses API 失敗'); return data; }
function parseJsonArray(data) { const text = data?.output_text || (data?.output || []).flatMap((x) => x.content || []).map((x) => x.text || '').join(''); const match = String(text).match(/\[[\s\S]*\]/); if (!match) throw new Error('AI 未回傳 JSON 陣列'); return JSON.parse(match[0]); }
function mockTrends() { const now = new Date().toISOString(); return [{ title: '台灣城市生活新話題', summary: '示範資料：整理近期城市生活與社群討論。', source_url: 'https://example.com/mock-trend', source_name: 'mock', content_type: 'text', fetched_at: now }]; }
function mockDrafts(trend) { return ['喵台灣宇宙', '貓掌江湖'].map((universe) => ({ universe, title: `${universe}｜${trend.title}`, summary: trend.summary, copy: `【${universe}】${trend.title}\n${trend.summary}\n（AI 草稿，發布前請人工審核）`, visual_prompt: defaultPrompt(universe, trend.title), suggested_at: new Date(Date.now() + 3600000).toISOString() })); }
function defaultPrompt(universe, title) { return universe === '貓掌江湖' ? `貓掌江湖、${title}、9:16 電影級布袋戲武俠場景、所有角色皆為母喵、戲劇燈光` : `喵台灣宇宙、${title}、直式社群視覺、溫暖明亮、貓咪角色`; }
function mockImage() { const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="100%" height="100%" fill="#fff4df"/><circle cx="540" cy="530" r="250" fill="#f59e0b"/><text x="540" y="950" text-anchor="middle" font-size="52" fill="#111827">MOCK IMAGE</text></svg>'; return { body: new TextEncoder().encode(svg), contentType: 'image/svg+xml' }; }
function mockVideo() { return { body: new TextEncoder().encode('MOCK VIDEO PLACEHOLDER'), contentType: 'video/mp4' }; }
function requireSecret(value, name) { if (!value) throw new Error(`尚未設定 ${name}`); }
function authHeaders(key, contentType) { return { Authorization: `Bearer ${key}`, 'Content-Type': contentType }; }
async function readJson(response) { const text = await response.text(); try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 500) } }; } }
function base64ToBytes(value) { const binary = atob(value); return Uint8Array.from(binary, (c) => c.charCodeAt(0)); }
function validUrl(value) { try { return new URL(value).protocol === 'https:'; } catch { return false; } }
function validDate(value) { return value && !Number.isNaN(new Date(value).getTime()); }
