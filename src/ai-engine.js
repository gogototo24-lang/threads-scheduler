const TZ = 'Asia/Taipei';

export function providers(env) {
  return {
    search: env.AI_SEARCH_PROVIDER || 'mock',
    text: env.AI_TEXT_PROVIDER || 'mock',
    image: env.AI_IMAGE_PROVIDER || 'mock',
    video: env.AI_VIDEO_PROVIDER || 'mock'
  };
}

export async function searchTrends(env) {
  // Mock mode is deliberate: no paid API is called until a provider is configured.
  if (providers(env).search === 'mock') {
    const now = new Date().toISOString();
    return [
      { title: '台灣城市生活新話題', summary: '示範資料：整理近期城市生活與社群討論，正式模式應替換為具來源的新聞或社群搜尋結果。', source_url: 'https://example.com/mock/taiwan-city', source_name: 'Mock Trend Feed', content_type: 'text', fetched_at: now },
      { title: '毛孩友善生活趨勢', summary: '示範資料：社群近期關注毛孩友善空間與日常照護。', source_url: 'https://example.com/mock/pets', source_name: 'Mock Trend Feed', content_type: 'image', fetched_at: now },
      { title: '台灣創意文化觀察', summary: '示範資料：整理台灣在地創意與文化活動的公開討論。', source_url: 'https://example.com/mock/culture', source_name: 'Mock Trend Feed', content_type: 'text', fetched_at: now },
      { title: '公共議題資訊整理', summary: '示範資料：僅提供中性、可查證的資訊整理，不生成政治說服內容。', source_url: 'https://example.com/mock/public-affairs', source_name: 'Mock Trend Feed', content_type: 'text', fetched_at: now }
    ];
  }
  throw new Error(`尚未實作搜尋 provider：${providers(env).search}`);
}

export async function generateDrafts(env, trend) {
  const restricted = /政治|選舉|政黨|總統|立委|公投|政治人物/.test(`${trend.title}${trend.summary}`);
  const mode = restricted ? '中性事實摘要與創意視覺概念，避免支持或反對任何人物、政黨或選項。' : '以輕鬆、可查證、不誇大的方式分享。';
  return ['喵台灣宇宙', '貓掌江湖'].map((universe) => ({
    universe,
    title: `${universe}｜${trend.title}`,
    summary: trend.summary,
    copy: `【${universe}】${trend.title}\n${trend.summary}\n${mode}\n（AI 草稿，發布前請人工審核）`,
    visual_prompt: `${universe}風格、台灣日常場景、貓咪角色、${trend.title}、溫暖插畫、直式構圖、無文字、避免真實政治人物肖像`,
    suggested_at: suggestedTime()
  }));
}

export async function generateImage(env, job) {
  if (providers(env).image !== 'mock') throw new Error(`尚未實作圖片 provider：${providers(env).image}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350"><rect width="100%" height="100%" fill="#fff4df"/><circle cx="540" cy="530" r="250" fill="#f6b65b"/><circle cx="450" cy="500" r="28"/><circle cx="630" cy="500" r="28"/><path d="M470 620 Q540 680 610 620" fill="none" stroke="#6b4226" stroke-width="18"/><text x="540" y="940" text-anchor="middle" font-family="sans-serif" font-size="42" fill="#6b4226">AI MOCK PREVIEW</text><text x="540" y="1010" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#6b4226">${escapeXml(job.input_prompt.slice(0, 45))}</text></svg>`;
  return { body: new TextEncoder().encode(svg), contentType: 'image/svg+xml' };
}

export async function generateVideo(env, job) {
  if (providers(env).video !== 'mock') throw new Error(`尚未實作影片 provider：${providers(env).video}`);
  return { body: new TextEncoder().encode('MOCK VIDEO PLACEHOLDER'), contentType: 'video/mp4' };
}

function suggestedTime() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  return d.toISOString();
}
function escapeXml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
