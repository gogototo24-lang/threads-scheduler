const GRAPH = 'https://graph.threads.net/v1.0';
const OAUTH_HOST = 'https://graph.threads.net';
const AUTH_URL = 'https://threads.net/oauth/authorize';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/') {
        return htmlResponse(renderApp(env.APP_NAME || 'Threads 自動排程器'));
      }

      if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
        const key = decodeURIComponent(url.pathname.slice('/media/'.length));
        const object = await env.MEDIA.get(key);
        if (!object) return new Response('Not found', { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('cache-control', 'public, max-age=31536000, immutable');
        return new Response(object.body, { headers });
      }

      if (request.method === 'GET' && url.pathname === '/auth/callback') {
        return handleOAuthCallback(request, env);
      }

      if (url.pathname.startsWith('/api/')) {
        if (!isAdmin(request, env)) return json({ error: '管理密碼錯誤' }, 401);

        if (request.method === 'GET' && url.pathname === '/api/status') {
          return apiStatus(env);
        }
        if (request.method === 'POST' && url.pathname === '/api/oauth-url') {
          return apiOAuthUrl(request, env);
        }
        if (request.method === 'GET' && url.pathname === '/api/posts') {
          return apiListPosts(env);
        }
        if (request.method === 'POST' && url.pathname === '/api/posts') {
          return apiCreatePost(request, env);
        }

        const publishMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/publish$/);
        if (request.method === 'POST' && publishMatch) {
          return apiPublishNow(env, decodeURIComponent(publishMatch[1]));
        }

        const deleteMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
        if (request.method === 'DELETE' && deleteMatch) {
          return apiDeletePost(env, decodeURIComponent(deleteMatch[1]));
        }
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: safeError(err) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduler(env));
  }
};

function isAdmin(request, env) {
  const supplied = request.headers.get('x-admin-key') || '';
  return !!env.ADMIN_KEY && supplied === env.ADMIN_KEY;
}

async function apiStatus(env) {
  const username = await getSetting(env, 'threads_username');
  const userId = await getSetting(env, 'threads_user_id');
  const expiresAt = await getSetting(env, 'token_expires_at');
  return json({
    connected: !!(username && userId && await getSetting(env, 'threads_access_token')),
    username,
    userId,
    tokenExpiresAt: expiresAt
  });
}

async function apiOAuthUrl(request, env) {
  if (!env.THREADS_APP_ID) return json({ error: '尚未設定 THREADS_APP_ID' }, 400);
  const base = getBaseUrl(request, env);
  const redirectUri = `${base}/auth/callback`;
  const state = crypto.randomUUID().replaceAll('-', '');
  const params = new URLSearchParams({
    client_id: env.THREADS_APP_ID,
    redirect_uri: redirectUri,
    scope: 'threads_basic,threads_content_publish',
    response_type: 'code',
    state
  });
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  headers.append('set-cookie', `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return new Response(JSON.stringify({ url: `${AUTH_URL}?${params}` }), { headers });
}

async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').replace(/#_$/, '');
  const state = url.searchParams.get('state') || '';
  const cookieState = readCookie(request, 'oauth_state');
  const base = getBaseUrl(request, env);

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirect(`${base}/?oauth=failed`);
  }
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) {
    return redirect(`${base}/?oauth=config`);
  }

  try {
    const redirectUri = `${base}/auth/callback`;
    const shortParams = new URLSearchParams({
      client_id: env.THREADS_APP_ID,
      client_secret: env.THREADS_APP_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });

    const shortRes = await fetch(`${OAUTH_HOST}/oauth/access_token?${shortParams}`, { method: 'POST' });
    const shortJson = await shortRes.json();
    if (!shortRes.ok || !shortJson.access_token) throw new Error(shortJson?.error?.message || '短效 token 取得失敗');

    const longParams = new URLSearchParams({
      grant_type: 'th_exchange_token',
      client_secret: env.THREADS_APP_SECRET,
      access_token: shortJson.access_token
    });
    const longRes = await fetch(`${OAUTH_HOST}/access_token?${longParams}`);
    const longJson = await longRes.json();
    if (!longRes.ok || !longJson.access_token) throw new Error(longJson?.error?.message || '長效 token 取得失敗');

    const token = longJson.access_token;
    const profileRes = await fetch(`${GRAPH}/me?fields=id,username&access_token=${encodeURIComponent(token)}`);
    const profile = await profileRes.json();
    if (!profileRes.ok || !profile.id) throw new Error(profile?.error?.message || 'Threads 帳號資料取得失敗');

    const expiresIn = Number(longJson.expires_in || 5184000);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    await setSetting(env, 'threads_access_token', token);
    await setSetting(env, 'threads_user_id', String(profile.id));
    await setSetting(env, 'threads_username', String(profile.username || ''));
    await setSetting(env, 'token_expires_at', expiresAt);
    await setSetting(env, 'token_last_refresh', new Date().toISOString());

    return new Response(null, {
      status: 302,
      headers: {
        location: `${base}/?connected=1`,
        'set-cookie': 'oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
      }
    });
  } catch (err) {
    return redirect(`${base}/?oauth=failed&message=${encodeURIComponent(safeError(err))}`);
  }
}

async function apiCreatePost(request, env) {
  const form = await request.formData();
  const text = String(form.get('text') || '').trim();
  const scheduledAtRaw = String(form.get('scheduledAt') || '');
  const file = form.get('image');

  if (file instanceof File && file.size > 0) {
    return json({ error: '圖片排程功能尚未啟用，目前先使用文字貼文。' }, 400);
  }

  if (!text) {
    return json({ error: '請輸入貼文文字' }, 400);
  }

  const scheduledAt = new Date(scheduledAtRaw);
  if (!scheduledAtRaw || Number.isNaN(scheduledAt.getTime())) {
    return json({ error: '排程時間格式錯誤' }, 400);
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO posts (id, text, media_type, media_key, media_url, scheduled_at, status)
    VALUES (?, ?, 'TEXT', NULL, NULL, ?, 'scheduled')
  `).bind(id, text, scheduledAt.toISOString()).run();

  return json({ ok: true, id });
}

async function apiListPosts(env) {
  const result = await env.DB.prepare(`
    SELECT id, text, media_type, media_url, scheduled_at, status, attempts, thread_id, error, created_at, published_at
    FROM posts
    ORDER BY datetime(scheduled_at) DESC
    LIMIT 100
  `).all();
  return json({ posts: result.results || [] });
}

async function apiDeletePost(env, id) {
  const row = await env.DB.prepare('SELECT media_key, status FROM posts WHERE id = ?').bind(id).first();
  if (!row) return json({ error: '找不到排程' }, 404);
  if (row.status === 'publishing') return json({ error: '正在發布中，暫時不能刪除' }, 409);
  if (row.media_key) await env.MEDIA.delete(row.media_key);
  await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function apiPublishNow(env, id) {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!post) return json({ error: '找不到排程' }, 404);
  if (post.status === 'published') return json({ error: '此貼文已發布' }, 409);
  try {
    const threadId = await publishPost(env, post);
    return json({ ok: true, threadId });
  } catch (err) {
    return json({ error: safeError(err) }, 500);
  }
}

async function runScheduler(env) {
  await maybeRefreshToken(env).catch(() => {});
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    SELECT * FROM posts
    WHERE status = 'scheduled' AND datetime(scheduled_at) <= datetime(?)
    ORDER BY datetime(scheduled_at) ASC
    LIMIT 10
  `).bind(now).all();

  for (const post of result.results || []) {
    try {
      await publishPost(env, post);
    } catch (err) {
      const attempts = Number(post.attempts || 0) + 1;
      if (attempts < 3) {
        const retryAt = new Date(Date.now() + attempts * 2 * 60 * 1000).toISOString();
        await env.DB.prepare(`
          UPDATE posts SET status='scheduled', attempts=?, error=?, scheduled_at=? WHERE id=?
        `).bind(attempts, safeError(err), retryAt, post.id).run();
      } else {
        await env.DB.prepare(`UPDATE posts SET status='failed', attempts=?, error=? WHERE id=?`)
          .bind(attempts, safeError(err), post.id).run();
      }
    }
  }
}

async function publishPost(env, post) {
  const token = await getSetting(env, 'threads_access_token');
  if (!token) throw new Error('尚未連接 Threads 帳號');

  const claim = await env.DB.prepare(`
    UPDATE posts SET status='publishing', error=NULL
    WHERE id=? AND status IN ('scheduled','failed')
  `).bind(post.id).run();

  if (!claim.meta?.changes) {
    const current = await env.DB.prepare('SELECT status FROM posts WHERE id=?').bind(post.id).first();
    if (current?.status === 'published') return post.thread_id;
  }

  try {
    const createParams = new URLSearchParams({
      access_token: token,
      media_type: post.media_type === 'IMAGE' ? 'IMAGE' : 'TEXT'
    });
    if (post.text) createParams.set('text', post.text);
    if (post.media_type === 'IMAGE' && post.media_url) createParams.set('image_url', post.media_url);

    const createRes = await fetch(`${GRAPH}/me/threads?${createParams}`, { method: 'POST' });
    const createJson = await createRes.json();
    if (!createRes.ok || !createJson.id) throw new Error(createJson?.error?.message || '建立 Threads 容器失敗');

    if (post.media_type === 'IMAGE') {
      await waitForContainer(token, createJson.id);
    }

    const publishParams = new URLSearchParams({
      access_token: token,
      creation_id: createJson.id
    });
    const publishRes = await fetch(`${GRAPH}/me/threads_publish?${publishParams}`, { method: 'POST' });
    const publishJson = await publishRes.json();
    if (!publishRes.ok || !publishJson.id) throw new Error(publishJson?.error?.message || 'Threads 發布失敗');

    await env.DB.prepare(`
      UPDATE posts SET status='published', thread_id=?, error=NULL, published_at=?, attempts=attempts+1 WHERE id=?
    `).bind(String(publishJson.id), new Date().toISOString(), post.id).run();
    return String(publishJson.id);
  } catch (err) {
    await env.DB.prepare(`UPDATE posts SET status='failed', error=?, attempts=attempts+1 WHERE id=?`)
      .bind(safeError(err), post.id).run();
    throw err;
  }
}

async function waitForContainer(token, id) {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(id)}?fields=status,error_message&access_token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (res.ok) {
      const status = String(data.status || '').toUpperCase();
      if (status === 'FINISHED' || status === 'PUBLISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(data.error_message || `媒體處理失敗：${status}`);
    }
    await sleep(1500);
  }
  throw new Error('圖片仍在處理中，稍後會自動重試');
}

async function maybeRefreshToken(env) {
  const token = await getSetting(env, 'threads_access_token');
  const expiresAt = await getSetting(env, 'token_expires_at');
  const lastRefresh = await getSetting(env, 'token_last_refresh');
  if (!token || !expiresAt) return;

  const msLeft = new Date(expiresAt).getTime() - Date.now();
  const sinceRefresh = lastRefresh ? Date.now() - new Date(lastRefresh).getTime() : Infinity;
  if (msLeft > 10 * 24 * 60 * 60 * 1000 || sinceRefresh < 24 * 60 * 60 * 1000) return;

  const params = new URLSearchParams({ grant_type: 'th_refresh_token', access_token: token });
  const res = await fetch(`${OAUTH_HOST}/refresh_access_token?${params}`);
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data?.error?.message || 'Token 刷新失敗');

  await setSetting(env, 'threads_access_token', data.access_token);
  const expiresIn = Number(data.expires_in || 5184000);
  await setSetting(env, 'token_expires_at', new Date(Date.now() + expiresIn * 1000).toISOString());
  await setSetting(env, 'token_last_refresh', new Date().toISOString());
}

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return row?.value || null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `).bind(key, String(value)).run();
}

function getBaseUrl(request, env) {
  return String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, '');
}

function readCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const parts = cookie.split(';').map(v => v.trim());
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx) === name) return part.slice(idx + 1);
  }
  return '';
}

function extensionFor(type, name) {
  const known = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };
  if (known[type]) return known[type];
  const m = String(name || '').match(/\.[a-z0-9]{1,6}$/i);
  return m ? m[0].toLowerCase() : '.img';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeError(err) { return String(err?.message || err || 'Unknown error').slice(0, 800); }
function redirect(location) { return new Response(null, { status: 302, headers: { location } }); }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function renderApp(appName) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#111111" />
<title>${escapeHtml(appName)}</title>
<style>
:root{font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;color:#111;background:#f4f5f7}
*{box-sizing:border-box}body{margin:0}.wrap{max-width:820px;margin:auto;padding:18px}.card{background:#fff;border:1px solid #e7e7e7;border-radius:20px;padding:18px;margin:14px 0;box-shadow:0 8px 28px rgba(0,0,0,.05)}h1{font-size:26px;margin:6px 0 2px}.sub{color:#666;margin:0 0 14px}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1 1 200px}label{font-weight:700;font-size:14px;display:block;margin:8px 0 6px}input,textarea,button{font:inherit}input,textarea{width:100%;border:1px solid #d7d7d7;border-radius:12px;padding:12px;background:#fff}textarea{min-height:130px;resize:vertical}button{border:0;border-radius:12px;padding:12px 16px;font-weight:800;cursor:pointer}.primary{background:#111;color:#fff}.secondary{background:#e9eef8}.danger{background:#ffe8e8;color:#a10000}.small{padding:8px 10px;font-size:13px}.status{display:inline-flex;gap:7px;align-items:center;padding:7px 10px;border-radius:999px;background:#f0f0f0;font-weight:700;font-size:13px}.dot{width:9px;height:9px;border-radius:50%;background:#999}.ok .dot{background:#1f9d55}.bad .dot{background:#d64545}.item{border-top:1px solid #eee;padding:14px 0}.item:first-child{border-top:0}.meta{font-size:12px;color:#666;display:flex;gap:8px;flex-wrap:wrap;margin:7px 0}.preview{max-width:160px;max-height:160px;border-radius:12px;border:1px solid #eee;margin-top:8px}.msg{padding:10px 12px;border-radius:12px;margin:10px 0;background:#f1f7ff}.err{background:#fff0f0;color:#8c1515}.muted{color:#777;font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}.pill{padding:4px 8px;border-radius:999px;background:#eee;font-size:12px;font-weight:700}.scheduled{background:#e7f0ff}.published{background:#e5f8eb}.failed{background:#ffe5e5}.publishing{background:#fff5d8}@media(max-width:520px){.wrap{padding:10px}.card{border-radius:16px;padding:14px}h1{font-size:23px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>🧵 ${escapeHtml(appName)}</h1>
    <p class="sub">文字＋圖片｜指定時間｜自動發布 Threads</p>
    <div id="connection" class="status"><span class="dot"></span><span>尚未檢查</span></div>
    <p class="muted" id="timezone"></p>
  </div>

  <div class="card">
    <label>管理密碼</label>
    <div class="row"><input id="adminKey" type="password" placeholder="Cloudflare ADMIN_KEY"/><button class="secondary" id="saveKey">儲存</button></div>
    <div class="actions"><button class="primary" id="connectBtn">連接 Threads</button><button class="secondary" id="refreshBtn">重新整理狀態</button></div>
    <div id="topMsg"></div>
  </div>

  <div class="card">
    <h2>新增排程</h2>
    <form id="composer">
      <label>貼文文字</label>
      <textarea name="text" id="text" placeholder="輸入 Threads 貼文內容…"></textarea>
      <label>圖片（稍後加入）</label>
      <input type="file" name="image" id="image" accept="image/*" disabled />
      <img id="localPreview" class="preview" style="display:none" />
      <label>發布時間</label>
      <input type="datetime-local" id="scheduledAtLocal" required />
      <div class="actions"><button class="primary" type="submit">加入排程</button><button class="secondary" type="button" id="set15">15 分鐘後</button></div>
    </form>
    <div id="composerMsg"></div>
  </div>

  <div class="card">
    <div class="row" style="align-items:center"><h2 style="margin:0">排程列表</h2><button class="secondary" id="loadPosts">更新列表</button></div>
    <div id="posts"><p class="muted">尚未載入。</p></div>
  </div>
</div>
<script>
const $ = s => document.querySelector(s);
const keyInput = $('#adminKey');
keyInput.value = localStorage.getItem('threads_admin_key') || '';
$('#timezone').textContent = '目前裝置時區：' + Intl.DateTimeFormat().resolvedOptions().timeZone;

function key(){ return keyInput.value.trim(); }
function headers(){ return {'X-Admin-Key': key()}; }
function msg(el, text, bad=false){ el.innerHTML = text ? '<div class="msg '+(bad?'err':'')+'">'+esc(text)+'</div>' : ''; }
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(iso){ if(!iso) return ''; return new Date(iso).toLocaleString(); }
function setDefaultTime(mins=30){ const d=new Date(Date.now()+mins*60000); d.setSeconds(0,0); const off=d.getTimezoneOffset()*60000; $('#scheduledAtLocal').value=new Date(d.getTime()-off).toISOString().slice(0,16); }
setDefaultTime();

$('#saveKey').onclick = () => { localStorage.setItem('threads_admin_key', key()); msg($('#topMsg'),'管理密碼已儲存在此瀏覽器。'); refreshStatus(); };
$('#set15').onclick = () => setDefaultTime(15);
$('#refreshBtn').onclick = () => { refreshStatus(); loadPosts(); };
$('#loadPosts').onclick = loadPosts;

$('#image').onchange = e => { const f=e.target.files?.[0]; const p=$('#localPreview'); if(!f){p.style.display='none';return;} p.src=URL.createObjectURL(f); p.style.display='block'; };

$('#connectBtn').onclick = async () => {
  try{
    const r=await fetch('/api/oauth-url',{method:'POST',headers:headers()}); const j=await r.json();
    if(!r.ok) throw new Error(j.error||'無法開始 Threads 授權');
    location.href=j.url;
  }catch(e){msg($('#topMsg'),e.message,true)}
};

$('#composer').onsubmit = async e => {
  e.preventDefault(); msg($('#composerMsg'),'');
  try{
    const fd=new FormData(); fd.append('text',$('#text').value); const f=$('#image').files?.[0]; if(f) fd.append('image',f);
    const local=$('#scheduledAtLocal').value; if(!local) throw new Error('請選擇發布時間');
    fd.append('scheduledAt',new Date(local).toISOString());
    const r=await fetch('/api/posts',{method:'POST',headers:headers(),body:fd}); const j=await r.json();
    if(!r.ok) throw new Error(j.error||'建立排程失敗');
    msg($('#composerMsg'),'✅ 已加入排程'); $('#text').value=''; $('#image').value=''; $('#localPreview').style.display='none'; setDefaultTime(); loadPosts();
  }catch(e){msg($('#composerMsg'),e.message,true)}
};

async function refreshStatus(){
  const c=$('#connection');
  try{
    const r=await fetch('/api/status',{headers:headers()}); const j=await r.json();
    if(!r.ok) throw new Error(j.error||'狀態讀取失敗');
    if(j.connected){ c.className='status ok'; c.innerHTML='<span class="dot"></span><span>已連接 @'+esc(j.username||'Threads')+'</span>'; }
    else { c.className='status bad'; c.innerHTML='<span class="dot"></span><span>尚未連接 Threads</span>'; }
  }catch(e){ c.className='status bad'; c.innerHTML='<span class="dot"></span><span>'+esc(e.message)+'</span>'; }
}

async function loadPosts(){
  const box=$('#posts'); box.innerHTML='<p class="muted">載入中…</p>';
  try{
    const r=await fetch('/api/posts',{headers:headers()}); const j=await r.json(); if(!r.ok) throw new Error(j.error||'列表讀取失敗');
    if(!j.posts?.length){ box.innerHTML='<p class="muted">目前沒有排程。</p>'; return; }
    box.innerHTML=j.posts.map(p=>{
      const st=esc(p.status); const text=esc(p.text||'(只有圖片)'); const img=p.media_url?'<img class="preview" src="'+esc(p.media_url)+'" loading="lazy">':'';
      const err=p.error?'<div class="msg err">'+esc(p.error)+'</div>':'';
      const buttons=p.status!=='published' ? '<div class="actions"><button class="small primary" onclick="publishNow(\''+p.id+'\')">立即發布</button><button class="small danger" onclick="delPost(\''+p.id+'\')">刪除</button></div>' : '';
      return '<div class="item"><div><span class="pill '+st+'">'+st+'</span></div><div style="white-space:pre-wrap;margin-top:8px">'+text+'</div>'+img+'<div class="meta"><span>排程：'+esc(fmt(p.scheduled_at))+'</span><span>嘗試：'+esc(p.attempts)+'</span>'+(p.published_at?'<span>已發布：'+esc(fmt(p.published_at))+'</span>':'')+'</div>'+err+buttons+'</div>';
    }).join('');
  }catch(e){ box.innerHTML='<div class="msg err">'+esc(e.message)+'</div>'; }
}

window.publishNow = async id => { if(!confirm('現在立即發布這則 Threads？')) return; try{ const r=await fetch('/api/posts/'+encodeURIComponent(id)+'/publish',{method:'POST',headers:headers()}); const j=await r.json(); if(!r.ok) throw new Error(j.error||'發布失敗'); alert('已發布'); loadPosts(); }catch(e){alert(e.message);loadPosts();} };
window.delPost = async id => { if(!confirm('確定刪除此排程？')) return; try{ const r=await fetch('/api/posts/'+encodeURIComponent(id),{method:'DELETE',headers:headers()}); const j=await r.json(); if(!r.ok) throw new Error(j.error||'刪除失敗'); loadPosts(); }catch(e){alert(e.message);} };

const qs=new URLSearchParams(location.search); if(qs.get('connected')) msg($('#topMsg'),'✅ Threads 已成功連接。'); if(qs.get('oauth')==='failed') msg($('#topMsg'),'Threads 授權失敗：'+(qs.get('message')||'請再試一次'),true);
if(key()){ refreshStatus(); loadPosts(); }
</script>
</body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
