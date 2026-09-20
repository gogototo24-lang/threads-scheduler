const TZ = 'Asia/Taipei';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';

export function providers(env) {
  return {
    search: env.AI_SEARCH_PROVIDER || 'mock',
    text: env.AI_TEXT_PROVIDER || 'mock',
    image: env.AI_IMAGE_PROVIDER || 'mock',
    video: env.AI_VIDEO_PROVIDER || 'mock'
  };
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
  const response = await openAiRequest(env, {
    model: env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
    tools: [{ type: 'web_search_preview' }],
    input: `請搜尋台灣最近 24 小時內的熱門新聞、生活、交通、科技、節慶與社群話題。只回傳 JSON 陣列，最多 5 筆、至少 3 筆。每筆欄位為 title、summary、source_url、source_name、content_type。每筆都必須有可直接開啟的來源網址與來源名稱，不得杜撰網址；優先政府、原始來源與可信新聞。政治或公共事務僅寫中性可查證事實，不得支持或反對任何人物、政黨或選項。繁體中文。`
  });
  const items = parseJsonArray(response);
  const fetchedAt = new Date().toISOString();
  return items.slice(0, 5).filter((item) => item.title && item.summary && validUrl(item.source_url)).map((item) => ({
    title: String(item.title).slice(0, 240), summary: String(item.summary).slice(0, 1200), source_url: item.source_url,
    source_name: String(item.source_name || new URL(item.source_url).hostname).slice(0, 160), content_type: item.content_type || 'text', fetched_at: fetchedAt
  }));
}

async function openAiDrafts(env, trend) {
  requireSecret(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
  const restricted = isPublicAffairs(trend);
  const response = await openAiRequest(env, {
    model: env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
    input: `根據以下有來源的台灣話題，為「喵台灣宇宙」與「貓掌江湖」各產生一份繁體中文 Threads 草稿。只回傳 JSON 陣列，兩筆欄位為 universe、title、summary、copy、visual_prompt、suggested_at；suggested_at 使用 ISO 8601。來源：${JSON.stringify(trend)}。${restricted ? '這是公共事務或政治題材：只能中性事實摘要與創意視覺概念，禁止支持或反對特定人物、政黨、候選人或選項。' : ''}「貓掌江湖」所有角色必須是母喵；避免真實人物肖像。`
  });
  const result = parseJsonArray(response);
  return ['喵台灣宇宙', '貓掌江湖'].map((universe) => {
    const found = result.find((item) => item.universe === universe) || {};
    return {
      universe, title: String(found.title || `${universe}｜${trend.title}`), summary: String(found.summary || trend.summary),
      copy: String(found.copy || `【${universe}】${trend.title}\n${trend.summary}\n（AI 草稿，發布前請人工審核）`),
      visual_prompt: String(found.visual_prompt || defaultPrompt(universe, trend.title)),
      suggested_at: validDate(found.suggested_at) ? found.suggested_at : new Date(Date.now() + 3600000).toISOString()
    };
  });
}

async function openAiImage(env, job, draft) {
  requireSecret(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
  const universe = draft?.universe || '';
  const style = universe === '貓掌江湖' ? '9:16 電影級布袋戲母喵武俠視覺，所有貓角色都是母喵' : '直式社群梗圖與電影海報感的喵台灣視覺';
  const response = await fetch(OPENAI_IMAGES_URL, {
    method: 'POST', headers: authHeaders(env.OPENAI_API_KEY, 'application/json'),
    body: JSON.stringify({ model: env.OPENAI_IMAGE_MODEL || 'gpt-image-1', size: '1024x1536', quality: env.OPENAI_IMAGE_QUALITY || 'auto', prompt: `${style}。${job.input_prompt}。繁體中文語境，不要生成文字、水印或真實政治人物肖像。` })
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error?.message || 'OpenAI 圖片生成失敗');
  const item = data?.data?.[0];
  if (!item?.b64_json && !item?.url) throw new Error('OpenAI 未回傳圖片');
  if (item.b64_json) return { body: base64ToBytes(item.b64_json), contentType: 'image/png' };
  const image = await fetch(item.url);
  if (!image.ok) throw new Error('OpenAI 圖片下載失敗');
  return { body: image.body, contentType: image.headers.get('content-type') || 'image/png' };
}

async function pixverseStart(env, job, draft, image) {
  requireSecret(env.PIXVERSE_API_KEY, 'PIXVERSE_API_KEY');
  if (!image?.url) throw new Error('PixVerse image-to-video 需要已完成的圖片');
  const base = (env.PIXVERSE_API_BASE_URL || 'https://app-api.pixverse.ai/openapi/v2').replace(/\/$/, '');
  const trace = crypto.randomUUID();
  const uploaded = await fetch(`${base}/image/upload`, { method: 'POST', headers: { 'API-KEY': env.PIXVERSE_API_KEY, 'Ai-trace-id': trace, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: image.url }) });
  const uploadJson = await readJson(uploaded);
  if (!uploaded.ok || !uploadJson?.Resp?.img_id && !uploadJson?.img_id) throw new Error(uploadJson?.ErrMsg || 'PixVerse 圖片上傳失敗');
  const imgId = uploadJson?.Resp?.img_id || uploadJson.img_id;
  const created = await fetch(`${base}/video/generate`, { method: 'POST', headers: { 'API-KEY': env.PIXVERSE_API_KEY, 'Ai-trace-id': crypto.randomUUID(), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: env.PIXVERSE_MODEL || 'v6', img_id: imgId, prompt: job.input_prompt, duration: 5, quality: '720p', aspect_ratio: '9:16' }) });
  const createdJson = await readJson(created);
  const videoId = createdJson?.Resp?.video_id || createdJson?.video_id;
  if (!created.ok || !videoId) throw new Error(createdJson?.ErrMsg || 'PixVerse 影片建立失敗');
  return { kind: 'pending', providerJobId: String(videoId) };
}

async function pixversePoll(env, job) {
  const base = (env.PIXVERSE_API_BASE_URL || 'https://app-api.pixverse.ai/openapi/v2').replace(/\/$/, '');
  const response = await fetch(`${base}/video/result/${encodeURIComponent(job.provider_job_id)}`, { headers: { 'API-KEY': env.PIXVERSE_API_KEY, 'Ai-trace-id': crypto.randomUUID() } });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.ErrMsg || 'PixVerse 狀態查詢失敗');
  const result = data?.Resp || data;
  const status = String(result.status || result.state || '').toLowerCase();
  if (['success', 'completed', 'succeeded'].includes(status)) return { status: 'completed', url: result.url || result.video_url || result.videoUrl };
  if (['failed', 'error', 'moderation', 'moderated'].includes(status)) return { status: 'failed', error: result.message || result.error || `PixVerse 影片狀態：${status}` };
  return { status: 'generating' };
}

async function openAiRequest(env, body) {
  const response = await fetch(OPENAI_RESPONSES_URL, { method: 'POST', headers: authHeaders(env.OPENAI_API_KEY, 'application/json'), body: JSON.stringify(body) });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data?.error?.message || 'OpenAI Responses API 失敗');
  return data;
}
function parseJsonArray(data) { const text = data?.output_text || (data?.output || []).flatMap((x) => x.content || []).map((x) => x.text || '').join(''); const match = String(text).match(/\[[\s\S]*\]/); if (!match) throw new Error('AI 未回傳有效 JSON 陣列'); try { return JSON.parse(match[0]); } catch { throw new Error('AI JSON 格式錯誤'); } }
function mockTrends() { const now = new Date().toISOString(); return [{ title: '台灣城市生活新話題', summary: '示範資料：整理近期城市生活與社群討論。', source_url: 'https://example.com/mock/taiwan-city', source_name: 'Mock Trend Feed', content_type: 'text', fetched_at: now }, { title: '毛孩友善生活趨勢', summary: '示範資料：社群近期關注毛孩友善空間。', source_url: 'https://example.com/mock/pets', source_name: 'Mock Trend Feed', content_type: 'image', fetched_at: now }, { title: '台灣創意文化觀察', summary: '示範資料：整理台灣在地創意與文化活動。', source_url: 'https://example.com/mock/culture', source_name: 'Mock Trend Feed', content_type: 'text', fetched_at: now }, { title: '公共議題資訊整理', summary: '示範資料：僅提供中性、可查證的資訊整理。', source_url: 'https://example.com/mock/public-affairs', source_name: 'Mock Trend Feed', content_type: 'text', fetched_at: now }]; }
function mockDrafts(trend) { return ['喵台灣宇宙', '貓掌江湖'].map((universe) => ({ universe, title: `${universe}｜${trend.title}`, summary: trend.summary, copy: `【${universe}】${trend.title}\n${trend.summary}\n（AI 草稿，發布前請人工審核）`, visual_prompt: defaultPrompt(universe, trend.title), suggested_at: new Date(Date.now() + 3600000).toISOString() })); }
function defaultPrompt(universe, title) { return universe === '貓掌江湖' ? `貓掌江湖、${title}、9:16 電影級布袋戲武俠場景、所有角色皆為母喵、戲劇燈光` : `喵台灣宇宙、${title}、台灣日常、直式社群梗圖與電影海報感、溫暖插畫`; }
function mockImage(job) { const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="100%" height="100%" fill="#fff4df"/><circle cx="540" cy="530" r="250" fill="#f6b65b"/><text x="540" y="940" text-anchor="middle" font-family="sans-serif" font-size="42" fill="#6b4226">AI MOCK PREVIEW</text><text x="540" y="1010" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#6b4226">${escapeXml(job.input_prompt.slice(0, 45))}</text></svg>`; return { body: new TextEncoder().encode(svg), contentType: 'image/svg+xml' }; }
function mockVideo() { return { body: new TextEncoder().encode('MOCK VIDEO PLACEHOLDER'), contentType: 'video/mp4' }; }
function isPublicAffairs(trend) { return /政治|選舉|政黨|總統|立委|公投|政治人物/.test(`${trend.title}${trend.summary}`); }
function requireSecret(value, name) { if (!value) throw new Error(`尚未設定 ${name}`); }
function authHeaders(key, contentType) { return { Authorization: `Bearer ${key}`, 'Content-Type': contentType }; }
async function readJson(response) { const text = await response.text(); try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 500) } }; } }
function base64ToBytes(value) { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
function validUrl(value) { try { const url = new URL(value); return url.protocol === 'https:'; } catch { return false; } }
function validDate(value) { return value && !Number.isNaN(new Date(value).getTime()); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function escapeXml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
