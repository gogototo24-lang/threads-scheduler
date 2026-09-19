import legacy from './worker.js';
import { providers, searchTrends, generateDrafts, generateImage, generateVideo } from './ai-engine.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/review' && request.method === 'GET') return reviewPage(request, env);
    if (url.pathname === '/api/ai/scan' && request.method === 'POST') return guarded(request, env, () => scan(env));
    if (url.pathname === '/api/ai/drafts' && request.method === 'GET') return guarded(request, env, () => listDrafts(env));
    const match = url.pathname.match(/^\/api\/ai\/drafts\/([^/]+)\/(approve|reject|image|video)$/);
    if (match && request.method === 'POST') return guarded(request, env, () => draftAction(request, env, decodeURIComponent(match[1]), match[2]));
    if (url.pathname === '/ai-scan' && request.method === 'POST') return guardedRedirect(request, env, () => scan(env), '/review');
    if (url.pathname === '/ai-approve' && request.method === 'POST') return guardedRedirect(request, env, () => approve(env, String((await request.formData()).get('id') || '')), '/review');
    return legacy.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await legacy.scheduled(controller, env, ctx);
      const last = await setting(env, 'ai_last_scan');
      if (!last || Date.now() - new Date(last).getTime() >= 60 * 60 * 1000) await scan(env);
      await processMediaJobs(env);
    })());
  }
};

async function guarded(request, env, fn) {
  if (!(await isAdmin(request, env))) return json({ error: '管理密碼錯誤' }, 401);
  try { return json(await fn()); } catch (e) { return json({ error: safeError(e) }, 400); }
}
async function guardedRedirect(request, env, fn, back) {
  if (!(await isAdmin(request, env))) return redirect('/?login=bad');
  try { await fn(); return redirect(back + '?ok=1'); } catch (e) { return redirect(back + '?error=' + encodeURIComponent(safeError(e))); }
}
async function scan(env) {
  const trends = await searchTrends(env);
  const created = [];
  for (const trend of trends.slice(0, 5)) {
    const trendId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO trends (id,title,summary,source_url,source_name,fetched_at,content_type,topic) VALUES (?,?,?,?,?,?,?,?)').bind(trendId, trend.title, trend.summary, trend.source_url, trend.source_name || '', trend.fetched_at || new Date().toISOString(), trend.content_type || 'text', trend.title).run();
    for (const draft of await generateDrafts(env, trend)) {
      const draftId = crypto.randomUUID();
      const imageJob = crypto.randomUUID();
      const videoJob = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO content_drafts (id,trend_id,universe,title,summary,copy,visual_prompt,suggested_at,image_job_id,video_job_id) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(draftId, trendId, draft.universe, draft.title, draft.summary, draft.copy, draft.visual_prompt, draft.suggested_at, imageJob, videoJob).run();
      await env.DB.prepare('INSERT INTO media_jobs (id,draft_id,kind,provider,input_prompt) VALUES (?,?,?,?,?)').bind(imageJob, draftId, 'image', providers(env).image, draft.visual_prompt).run();
      await env.DB.prepare('INSERT INTO media_jobs (id,draft_id,kind,provider,input_prompt) VALUES (?,?,?,?,?)').bind(videoJob, draftId, 'video', providers(env).video, `${draft.visual_prompt}, 9:16 短影片`).run();
      created.push(draftId);
    }
  }
  await setSetting(env, 'ai_last_scan', new Date().toISOString());
  return { trends: Math.min(trends.length, 5), drafts: created.length, mode: providers(env) };
}
async function listDrafts(env) {
  const rows = (await env.DB.prepare(`SELECT d.*, t.source_url, t.source_name, t.fetched_at, i.status image_status, i.output_url image_url, v.status video_status, v.output_url video_url FROM content_drafts d JOIN trends t ON t.id=d.trend_id LEFT JOIN media_jobs i ON i.id=d.image_job_id LEFT JOIN media_jobs v ON v.id=d.video_job_id WHERE d.review_status='pending' ORDER BY d.created_at DESC LIMIT 100`).all()).results || [];
  return { drafts: rows };
}
async function draftAction(request, env, id, action) {
  if (action === 'approve') return approve(env, id);
  if (action === 'reject') { await env.DB.prepare("UPDATE content_drafts SET review_status='discarded', updated_at=CURRENT_TIMESTAMP WHERE id=? AND review_status='pending'").bind(id).run(); return { ok: true }; }
  const row = await env.DB.prepare('SELECT * FROM content_drafts WHERE id=?').bind(id).first();
  if (!row) throw new Error('找不到草稿');
  const kind = action === 'image' ? 'image' : 'video';
  const jobId = kind === 'image' ? row.image_job_id : row.video_job_id;
  await env.DB.prepare("UPDATE media_jobs SET status='pending', error=NULL, attempts=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(jobId).run();
  return { ok: true, jobId };
}
async function approve(env, id) {
  const row = await env.DB.prepare("SELECT d.*, i.status image_status, i.output_url image_url FROM content_drafts d LEFT JOIN media_jobs i ON i.id=d.image_job_id WHERE d.id=? AND d.review_status='pending'").bind(id).first();
  if (!row) throw new Error('草稿不存在或已處理');
  const scheduled = new Date(row.suggested_at);
  if (Number.isNaN(scheduled.getTime()) || scheduled <= new Date()) scheduled.setTime(Date.now() + 15 * 60 * 1000);
  const postId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO posts (id,text,media_type,media_key,media_url,scheduled_at,status) VALUES (?,?,?,?,?,?,'scheduled')").bind(postId, row.copy, row.image_url ? 'IMAGE' : 'TEXT', row.image_url ? row.image_url.split('/media/').pop() : null, row.image_url || null, scheduled.toISOString()).run();
  await env.DB.prepare("UPDATE content_drafts SET review_status='approved', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  return { ok: true, postId };
}
async function processMediaJobs(env) {
  const rows = (await env.DB.prepare("SELECT * FROM media_jobs WHERE status='pending' ORDER BY created_at LIMIT 10").all()).results || [];
  for (const job of rows) {
    await env.DB.prepare("UPDATE media_jobs SET status='generating', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(job.id).run();
    try {
      const result = job.kind === 'image' ? await generateImage(env, job) : await generateVideo(env, job);
      const key = `ai/${job.kind}/${job.id}${job.kind === 'image' ? '.svg' : '.mp4'}`;
      await env.MEDIA.put(key, result.body, { httpMetadata: { contentType: result.contentType, cacheControl: 'public, max-age=31536000, immutable' } });
      const url = `${String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/media/${encodeURIComponent(key)}`;
      await env.DB.prepare("UPDATE media_jobs SET status='completed', output_key=?, output_url=?, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(key, url, job.id).run();
    } catch (e) { await env.DB.prepare("UPDATE media_jobs SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(safeError(e), job.id).run(); }
  }
}
async function reviewPage(request, env) {
  if (!(await isAdmin(request, env))) return redirect('/?login=bad');
  const { drafts } = await listDrafts(env);
  const cards = drafts.length ? drafts.map(d => `<article class="draft"><h2>${esc(d.title)}</h2><p><b>宇宙：</b>${esc(d.universe)}</p><p>${esc(d.summary)}</p><p><a href="${esc(d.source_url)}" target="_blank" rel="noopener">來源：${esc(d.source_name || d.source_url)}</a><br><small>抓取：${esc(d.fetched_at)}</small></p><pre>${esc(d.copy)}</pre>${d.image_url ? `<img src="${esc(d.image_url)}" alt="AI 圖片預覽">` : `<p>圖片：${esc(d.image_status || 'pending')}</p>`}${d.video_url ? `<video controls src="${esc(d.video_url)}"></video>` : `<p>影片：${esc(d.video_status || 'pending')}（9:16）</p>`}<p>建議發布：${esc(d.suggested_at)}</p><form method="post" action="/ai-approve"><input type="hidden" name="id" value="${esc(d.id)}"><button>核准並排程</button></form><div class="actions"><form method="post" action="/api/ai/drafts/${encodeURIComponent(d.id)}/image"><button>重新生成圖片</button></form><form method="post" action="/api/ai/drafts/${encodeURIComponent(d.id)}/video"><button>重新生成影片</button></form><form method="post" action="/api/ai/drafts/${encodeURIComponent(d.id)}/reject"><button>捨棄</button></form></div></article>`).join('') : '<p>目前沒有待審核草稿。</p>';
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 待審核內容</title><style>body{font-family:system-ui;background:#f4f5f7;margin:0}.wrap{max-width:850px;margin:auto;padding:16px}.card,.draft{background:#fff;padding:18px;border-radius:16px;margin:12px 0}pre{white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:8px}.draft img,.draft video{max-width:100%;max-height:420px;display:block;margin:10px 0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}button{padding:10px;border:1px solid #ccd;border-radius:8px;background:#fff}button:first-child{background:#111;color:#fff}a{color:#075985}</style><main class="wrap"><section class="card"><h1>🤖 AI 待審核內容</h1><p>目前 provider：${esc(JSON.stringify(providers(env)))}。預設為 mock，不會呼叫付費 API。</p><form method="post" action="/ai-scan"><button>掃描熱門話題並產生草稿</button></form><p><a href="/">回到排程器</a></p></section>${cards}</main>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
async function isAdmin(request, env) { if (!env.ADMIN_KEY) return false; if ((request.headers.get('x-admin-key') || '') === env.ADMIN_KEY) return true; const cookie = request.headers.get('cookie') || ''; const value = cookie.split(';').map(x => x.trim()).find(x => x.startsWith('admin_session='))?.split('=')[1]; return !!value && value === await session(env.ADMIN_KEY); }
async function session(secret) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('threads-scheduler:' + secret)); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function setting(env, key) { return (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value || null; }
async function setSetting(env, key, value) { await env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').bind(key, value).run(); }
function redirect(location) { return new Response(null, { status: 302, headers: { location } }); }
function json(value, status=200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function safeError(e) { return String(e?.message || e || 'Unknown error').slice(0, 800); }
