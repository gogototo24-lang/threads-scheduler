import legacy from './worker.js';
import { generateImage, startVideo, pollVideo, providers, searchTrends, generateDrafts } from './ai-engine.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/review' && request.method === 'GET') return reviewPage(request, env);
    if (url.pathname === '/api/ai/scan' && request.method === 'POST') return guarded(request, env, () => scan(env));
    if (url.pathname === '/api/ai/drafts' && request.method === 'GET') return guarded(request, env, () => listDrafts(env));
    const match = url.pathname.match(/^\/api\/ai\/drafts\/([^/]+)\/(approve|reject|image|video|edit)$/);
    if (match && request.method === 'POST') return guarded(request, env, () => draftAction(request, env, decodeURIComponent(match[1]), match[2]));
    if (url.pathname === '/ai-scan' && request.method === 'POST') return guardedRedirect(request, env, () => scan(env), '/review');
    if (url.pathname === '/ai-approve' && request.method === 'POST') return guardedRedirect(request, env, async () => approve(env, String((await request.formData()).get('id') || '')), '/review');
    return legacy.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => { await legacy.scheduled(controller, env, ctx); const last = await setting(env, 'ai_last_scan'); if (!last || Date.now() - new Date(last).getTime() >= 3600000) await scan(env); await processMediaJobs(env); })());
  }
};

async function guarded(request, env, fn) { if (!(await isAdmin(request, env))) return json({ error: '管理密碼錯誤' }, 401); try { return json(await fn()); } catch (e) { return json({ error: safeError(e) }, 400); } }
async function guardedRedirect(request, env, fn, back) { if (!(await isAdmin(request, env))) return redirect('/?login=bad'); try { await fn(); return redirect(back + '?ok=1'); } catch (e) { return redirect(back + '?error=' + encodeURIComponent(safeError(e))); } }

async function scan(env) {
  const trends = await searchTrends(env); const created = [];
  for (const trend of trends.slice(0, 5)) {
    const trendId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO trends (id,title,summary,source_url,source_name,fetched_at,content_type,topic) VALUES (?,?,?,?,?,?,?,?)').bind(trendId, trend.title, trend.summary, trend.source_url, trend.source_name, trend.fetched_at, trend.content_type || 'text', trend.title).run();
    for (const draft of await generateDrafts(env, trend)) {
      const draftId = crypto.randomUUID(), imageJob = crypto.randomUUID(), videoJob = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO content_drafts (id,trend_id,universe,title,summary,copy,visual_prompt,suggested_at,image_job_id,video_job_id) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(draftId, trendId, draft.universe, draft.title, draft.summary, draft.copy, draft.visual_prompt, draft.suggested_at, imageJob, videoJob).run();
      await env.DB.prepare('INSERT INTO media_jobs (id,draft_id,kind,provider,input_prompt,requested_at) VALUES (?,?,?,?,?,NULL)').bind(imageJob, draftId, 'image', providers(env).image, draft.visual_prompt).run();
      await env.DB.prepare('INSERT INTO media_jobs (id,draft_id,kind,provider,input_prompt,requested_at) VALUES (?,?,?,?,?,NULL)').bind(videoJob, draftId, 'video', providers(env).video, `${draft.visual_prompt}, 9:16`).run(); created.push(draftId);
    }
  }
  await setSetting(env, 'ai_last_scan', new Date().toISOString()); return { trends: Math.min(trends.length, 5), drafts: created.length, mode: providers(env) };
}

async function listDrafts(env) { const rows = (await env.DB.prepare(`SELECT d.*, t.title topic, t.source_url, t.source_name, i.provider image_provider, i.status image_status, i.error image_error, i.output_url image_url, v.provider video_provider, v.status video_status, v.error video_error, v.output_url video_url FROM content_drafts d JOIN trends t ON t.id=d.trend_id LEFT JOIN media_jobs i ON i.id=d.image_job_id LEFT JOIN media_jobs v ON v.id=d.video_job_id WHERE d.review_status='pending' ORDER BY d.created_at DESC`).all()).results || []; return { drafts: rows }; }

async function draftAction(request, env, id, action) {
  if (action === 'approve') return approve(env, id);
  if (action === 'reject') { await env.DB.prepare("UPDATE content_drafts SET review_status='discarded',updated_at=CURRENT_TIMESTAMP WHERE id=? AND review_status='pending'").bind(id).run(); return { ok: true }; }
  const row = await env.DB.prepare('SELECT * FROM content_drafts WHERE id=?').bind(id).first(); if (!row) throw new Error('找不到草稿');
  if (action === 'edit') { const form = await request.formData(); const title = String(form.get('title') || '').trim(); const copy = String(form.get('copy') || '').trim(); const visual = String(form.get('visual_prompt') || '').trim(); const suggested = String(form.get('suggested_at') || '').trim(); if (!title || !copy || !visual || !suggested || Number.isNaN(new Date(suggested).getTime())) throw new Error('文案或建議發布時間格式錯誤'); await env.DB.prepare('UPDATE content_drafts SET title=?,copy=?,visual_prompt=?,suggested_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND review_status=?').bind(title, copy, visual, new Date(suggested).toISOString(), id, 'pending').run(); return { ok: true }; }
  const kind = action === 'image' ? 'image' : 'video'; const jobId = kind === 'image' ? row.image_job_id : row.video_job_id;
  if (kind === 'video') { const image = await env.DB.prepare("SELECT status FROM media_jobs WHERE id=? AND kind='image'").bind(row.image_job_id).first(); if (image?.status !== 'completed') throw new Error('請先生成圖片'); }
  await env.DB.prepare("UPDATE media_jobs SET status='pending',requested_at=CURRENT_TIMESTAMP,error=NULL,attempts=0,provider_job_id=NULL,output_key=NULL,output_url=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(jobId).run(); return { ok: true, jobId };
}

async function approve(env, id) {
  const row = await env.DB.prepare("SELECT d.*, i.status image_status, i.provider image_provider, i.output_key image_key, i.output_url image_url FROM content_drafts d LEFT JOIN media_jobs i ON i.id=d.image_job_id WHERE d.id=? AND d.review_status='pending'").bind(id).first();
  if (!row) throw new Error('草稿不存在或已處理');
  if (row.image_status !== 'completed' || row.image_provider === 'mock' || !row.image_url || String(row.image_key || '').endsWith('.svg')) throw new Error('圖片尚未完成，或目前是 mock 圖片，不能核准圖片並排程');
  const scheduled = new Date(row.suggested_at); if (Number.isNaN(scheduled.getTime()) || scheduled <= new Date()) scheduled.setTime(Date.now() + 900000);
  const postId = crypto.randomUUID(); await env.DB.prepare("INSERT INTO posts (id,text,media_type,media_key,media_url,scheduled_at,status) VALUES (?,?,?,?,?,?,'scheduled')").bind(postId, row.copy, 'IMAGE', row.image_key, row.image_url, scheduled.toISOString()).run(); await env.DB.prepare("UPDATE content_drafts SET review_status='approved',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run(); return { ok: true, postId };
}

async function approveText(env, id) { const row = await env.DB.prepare("SELECT * FROM content_drafts WHERE id=? AND review_status='pending'").bind(id).first(); if (!row) throw new Error('草稿不存在或已處理'); const scheduled = new Date(row.suggested_at); if (Number.isNaN(scheduled.getTime()) || scheduled <= new Date()) scheduled.setTime(Date.now() + 900000); const postId = crypto.randomUUID(); await env.DB.prepare("INSERT INTO posts (id,text,media_type,media_key,media_url,scheduled_at,status) VALUES (?,?, 'TEXT',NULL,NULL,?,'scheduled')").bind(postId, row.copy, scheduled.toISOString()).run(); await env.DB.prepare("UPDATE content_drafts SET review_status='approved',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run(); return { ok: true, postId }; }

async function processMediaJobs(env) {
  const pending = (await env.DB.prepare("SELECT * FROM media_jobs WHERE status='pending' AND requested_at IS NOT NULL ORDER BY requested_at LIMIT 10").all()).results || [];
  const generating = (await env.DB.prepare("SELECT * FROM media_jobs WHERE kind='video' AND status='generating' AND requested_at IS NOT NULL AND provider_job_id IS NOT NULL LIMIT 10").all()).results || [];
  for (const job of pending) await runMediaJob(env, job);
  for (const job of generating) await pollMediaJob(env, job);
}
async function runMediaJob(env, job) {
  await env.DB.prepare("UPDATE media_jobs SET status='generating',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND requested_at IS NOT NULL").bind(job.id).run();
  try { const draft = await env.DB.prepare('SELECT * FROM content_drafts WHERE id=?').bind(job.draft_id).first(); if (job.kind === 'video') { const image = await env.DB.prepare("SELECT * FROM media_jobs WHERE id=? AND kind='image' AND status='completed'").bind(draft.image_job_id).first(); if (!image) throw new Error('請先生成圖片'); const result = await startVideo(env, job, draft, image); if (result.kind === 'pending') { await env.DB.prepare("UPDATE media_jobs SET provider_job_id=?,status='generating',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(result.providerJobId, job.id).run(); return; } await saveMedia(env, job, result.result); return; } await saveMedia(env, job, await generateImage(env, job, draft)); } catch (e) { await env.DB.prepare("UPDATE media_jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(safeError(e), job.id).run(); }
}
async function pollMediaJob(env, job) { try { const result = await pollVideo(env, job); if (result.status === 'generating') return; if (result.status === 'failed') throw new Error(result.error || '影片生成失敗'); const downloaded = await fetch(result.url); if (!downloaded.ok) throw new Error('影片下載失敗'); await saveMedia(env, job, { body: downloaded.body, contentType: downloaded.headers.get('content-type') || 'video/mp4' }); } catch (e) { await env.DB.prepare("UPDATE media_jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(safeError(e), job.id).run(); } }
async function saveMedia(env, job, result) { const extension = job.kind === 'image' ? (result.contentType === 'image/svg+xml' ? '.svg' : '.png') : '.mp4'; const key = `ai/${job.kind}/${job.id}${extension}`; await env.MEDIA.put(key, result.body, { httpMetadata: { contentType: result.contentType, cacheControl: 'public, max-age=31536000, immutable' } }); const url = `${String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/media/${encodeURIComponent(key)}`; await env.DB.prepare("UPDATE media_jobs SET status='completed',output_key=?,output_url=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(key, url, job.id).run(); }

async function reviewPage(request, env) { if (!(await isAdmin(request, env))) return redirect('/?login=bad'); const { drafts } = await listDrafts(env); const cards = drafts.length ? drafts.map(renderDraft).join('') : '<p>目前沒有待審核草稿。</p>'; return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 待審核內容</title><style>body{font-family:system-ui;max-width:1100px;margin:auto;padding:16px;background:#f5f5f5}.draft{background:white;border-radius:14px;padding:18px;margin:16px 0}textarea,input{width:100%;box-sizing:border-box;padding:8px;margin:4px 0 10px}button{padding:9px 12px;margin:4px;border-radius:8px;border:1px solid #bbb}img,video{max-width:100%;max-height:480px;display:block;margin:8px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.error{color:#b42318}@media(max-width:700px){.grid{grid-template-columns:1fr}}</style><h1>AI 待審核內容</h1>${cards}`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }); }
function renderDraft(d) { const image = d.image_url && d.image_status === 'completed' ? `<img src="${esc(d.image_url)}" alt="圖片預覽">` : '<p>圖片尚未完成</p>'; const video = d.video_url && d.video_status === 'completed' ? `<video src="${esc(d.video_url)}" controls></video>` : '<p>影片尚未完成</p>'; return `<article class="draft"><h2>${esc(d.title)}</h2><p><b>話題：</b>${esc(d.topic)}　<b>宇宙：</b>${esc(d.universe)}</p><p><b>來源：</b><a href="${esc(d.source_url)}" target="_blank">${esc(d.source_name || d.source_url)}</a></p><form method="post" action="/api/ai/drafts/${encodeURIComponent(d.id)}/edit"><label>標題</label><input name="title" value="${esc(d.title)}"><label>AI 文案</label><textarea name="copy">${esc(d.copy)}</textarea><label>visual prompt</label><textarea name="visual_prompt">${esc(d.visual_prompt)}</textarea><label>建議發布時間</label><input type="datetime-local" name="suggested_at" value="${esc(localDate(d.suggested_at))}"><button>儲存文案修改</button></form><p><b>圖片：</b>${esc(d.image_provider)} / ${esc(d.image_status)} ${d.image_error ? `<span class="error">${esc(d.image_error)}</span>` : ''}</p>${image}<form method="post" action="/api/ai/drafts/${encodeURIComponent(d.id)}/image"><button>生成圖片／重新生成圖片</button></form><p><b>影片：</b>${esc(d.video_provider)} / ${esc(d.video_status)} ${d.video_error ? `<span class="error">${esc(d.video_error)}</span>` : ''}</p>${video}<form method="post" action="/api/ai/drafts/${encodeURIComponent(d.id)}/video"><button>生成影片／重新生成影片</button></form><form method="post" action="/api/ai/drafts/${encodeURIComponent(d.id)}/approve"><button>核准圖片並排程</button></form><form method="post" action="/api/ai/drafts/${encodeURIComponent(d.id)}/text"><button>只發文字</button></form><form method="post" action="/api/ai/drafts/${encodeURIComponent(d.id)}/reject"><button>捨棄</button></form></article>`; }
function localDate(value) { const d = new Date(value); if (Number.isNaN(d.getTime())) return ''; const p = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d); return p.replace(' ', 'T'); }
async function isAdmin(request, env) { if (!env.ADMIN_KEY) return false; if ((request.headers.get('x-admin-key') || '') === env.ADMIN_KEY) return true; return (request.headers.get('cookie') || '').split(';').some((x) => x.trim() === `admin_session=${await session(env.ADMIN_KEY)}`); }
async function session(secret) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('threads-scheduler:' + secret)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
async function setting(env, key) { return (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value || null; }
async function setSetting(env, key, value) { await env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').bind(key, String(value)).run(); }
function redirect(location) { return new Response(null, { status: 302, headers: { location } }); }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeError(e) { return String(e?.message || e || 'Unknown error').slice(0, 800); }
