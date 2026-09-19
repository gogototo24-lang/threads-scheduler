const GRAPH = 'https://graph.threads.net/v1.0';
const OAUTH_HOST = 'https://graph.threads.net';
const AUTH_URL = 'https://threads.net/oauth/authorize';
const TZ = 'Asia/Taipei';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/') {
        return showHome(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/login') {
        return handleAdminLogin(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/schedule') {
        if (!(await isAdmin(request, env))) return redirect('/?login=bad');
        try {
          await createScheduledPost(request, env);
          return redirect('/?scheduled=1');
        } catch (error) {
          return redirect('/?error=' + encodeURIComponent(safeError(error)));
        }
      }

      if (request.method === 'POST' && url.pathname === '/edit') {
        if (!(await isAdmin(request, env))) return redirect('/?login=bad');
        try {
          await updateScheduledPost(request, env);
          return redirect('/?updated=1');
        } catch (error) {
          return redirect('/?error=' + encodeURIComponent(safeError(error)));
        }
      }

      if (request.method === 'POST' && url.pathname === '/delete') {
        if (!(await isAdmin(request, env))) return redirect('/?login=bad');
        try {
          await deleteScheduledPost(request, env);
          return redirect('/?deleted=1');
        } catch (error) {
          return redirect('/?error=' + encodeURIComponent(safeError(error)));
        }
      }

      if (request.method === 'GET' && url.pathname === '/connect') {
        return connectOAuth(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/auth/callback') {
        return handleOAuthCallback(request, env);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
        return serveMedia(request, env);
      }

      if (url.pathname.startsWith('/api/')) {
        if (!(await isAdmin(request, env))) return json({ error: '管理密碼錯誤' }, 401);

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
          try {
            const id = await createScheduledPost(request, env);
            return json({ ok: true, id });
          } catch (error) {
            return json({ error: safeError(error) }, 400);
          }
        }

        const publishMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/publish$/);
        if (request.method === 'POST' && publishMatch) {
          try {
            const id = decodeURIComponent(publishMatch[1]);
            const result = await publishNow(env, id);
            return json({ ok: true, threadId: result.threadId, permalink: result.permalink });
          } catch (error) {
            return json({ error: safeError(error) }, 500);
          }
        }

        const editMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
        if (request.method === 'PUT' && editMatch) {
          try {
            const id = decodeURIComponent(editMatch[1]);
            await updateScheduledPost(request, env, id);
            return json({ ok: true });
          } catch (error) {
            return json({ error: safeError(error) }, 400);
          }
        }

        if (request.method === 'DELETE' && editMatch) {
          try {
            const id = decodeURIComponent(editMatch[1]);
            await deleteScheduledPostById(env, id);
            return json({ ok: true });
          } catch (error) {
            return json({ error: safeError(error) }, 409);
          }
        }
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: safeError(error) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduler(env));
  }
};

async function showHome(request, env) {
  const loggedIn = await isAdmin(request, env);
  const username = await getSetting(env, 'threads_username');
  const posts = loggedIn
    ? (await env.DB.prepare('SELECT * FROM posts ORDER BY datetime(scheduled_at) DESC LIMIT 100').all()).results || []
    : [];
  return htmlResponse(renderApp({
    appName: env.APP_NAME || 'Threads 自動排程器',
    loggedIn,
    username,
    posts,
    requestUrl: request.url,
    statusMessage: getQuery(request.url, 'error') || getQuery(request.url, 'scheduled') || getQuery(request.url, 'updated') || getQuery(request.url, 'deleted') || getQuery(request.url, 'connected') || getQuery(request.url, 'oauth') || ''
  }));
}

function getQuery(url, key) {
  const params = new URL(url).searchParams;
  const value = params.get(key);
  if (key === 'scheduled' && value === '1') return '✅ 已加入排程';
  if (key === 'updated' && value === '1') return '✅ 排程已更新';
  if (key === 'deleted' && value === '1') return '✅ 排程已刪除';
  if (key === 'connected' && value === '1') return '✅ Threads 已成功連接';
  if (key === 'oauth' && value === 'failed') return '⚠️ Threads 授權失敗';
  if (key === 'error') return params.get('error') ? '⚠️ ' + params.get('error') : '';
  return '';
}

async function handleAdminLogin(request, env) {
  const form = await request.formData();
  const supplied = String(form.get('adminKey') || '');

  if (!env.ADMIN_KEY || supplied !== env.ADMIN_KEY) {
    return redirect('/?login=bad');
  }

  const session = await adminSession(env.ADMIN_KEY);
  return new Response(null, {
    status: 302,
    headers: {
      location: '/?login=ok',
      'set-cookie': `admin_session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
    }
  });
}

async function connectOAuth(request, env) {
  if (!(await isAdmin(request, env))) return redirect('/?login=bad');
  const response = await apiOAuthUrl(request, env);
  const payload = await response.clone().json();
  const headers = new Headers({ location: payload.url });
  const cookie = response.headers.get('set-cookie');
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

async function apiOAuthUrl(request, env) {
  if (!env.THREADS_APP_ID) {
    return json({ error: '尚未設定 THREADS_APP_ID' }, 400);
  }

  const base = getBaseUrl(request, env);
  const state = crypto.randomUUID().replaceAll('-', '');
  const params = new URLSearchParams({
    client_id: env.THREADS_APP_ID,
    redirect_uri: `${base}/auth/callback`,
    scope: 'threads_basic,threads_content_publish',
    response_type: 'code',
    state
  });

  return new Response(JSON.stringify({ url: `${AUTH_URL}?${params}` }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    }
  });
}

async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').replace(/#_$/, '');
  const state = url.searchParams.get('state') || '';
  const cookieState = readCookie(request, 'oauth_state');

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirect('/?oauth=failed');
  }

  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) {
    return redirect('/?oauth=config');
  }

  try {
    const base = getBaseUrl(request, env);
    const redirectUri = `${base}/auth/callback`;

    const short = await fetch(`${OAUTH_HOST}/oauth/access_token?${new URLSearchParams({
      client_id: env.THREADS_APP_ID,
      client_secret: env.THREADS_APP_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })}`, { method: 'POST' });

    const shortJson = await short.json();
    if (!short.ok || !shortJson.access_token) {
      throw new Error(shortJson?.error?.message || '短效 token 取得失敗');
    }

    const long = await fetch(`${OAUTH_HOST}/access_token?${new URLSearchParams({
      grant_type: 'th_exchange_token',
      client_secret: env.THREADS_APP_SECRET,
      access_token: shortJson.access_token
    })}`);

    const longJson = await long.json();
    if (!long.ok || !longJson.access_token) {
      throw new Error(longJson?.error?.message || '長效 token 取得失敗');
    }

    const profile = await fetch(`${GRAPH}/me?fields=id,username&access_token=${encodeURIComponent(longJson.access_token)}`);
    const profileJson = await profile.json();
    if (!profile.ok || !profileJson.id) {
      throw new Error(profileJson?.error?.message || 'Threads 帳號資料取得失敗');
    }

    const expiresIn = Number(longJson.expires_in || 5184000);
    await setSetting(env, 'threads_access_token', String(longJson.access_token));
    await setSetting(env, 'threads_user_id', String(profileJson.id));
    await setSetting(env, 'threads_username', String(profileJson.username || ''));
    await setSetting(env, 'token_expires_at', new Date(Date.now() + expiresIn * 1000).toISOString());
    await setSetting(env, 'token_last_refresh', new Date().toISOString());

    return new Response(null, {
      status: 302,
      headers: {
        location: '/?connected=1',
        'set-cookie': 'oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
      }
    });
  } catch (error) {
    return redirect('/?oauth=failed&error=' + encodeURIComponent(safeError(error)));
  }
}

async function apiStatus(env) {
  const username = await getSetting(env, 'threads_username');
  const userId = await getSetting(env, 'threads_user_id');
  const expiresAt = await getSetting(env, 'token_expires_at');
  const connected = !!(await getSetting(env, 'threads_access_token')) && !!username && !!userId;
  return json({
    connected,
    username,
    userId,
    tokenExpiresAt: expiresAt
  });
}

async function createScheduledPost(requestOrForm, env, maybeReq) {
  const form = requestOrForm instanceof FormData ? requestOrForm : await requestOrForm.formData();
  const request = maybeReq || requestOrForm;
  const text = String(form.get('text') || '').trim();
  const rawTime = String(form.get('scheduledAtLocal') || form.get('scheduledAt') || '');
  const quick = String(form.get('quick') || '');
  const file = form.get('image');

  if (!text && !(file instanceof File && file.size > 0)) {
    throw new Error('請輸入貼文文字或上傳圖片');
  }

  const scheduledAt = resolveScheduledAt(rawTime, quick, Date.now());
  const media = await storeImageIfAny(file, env, request);

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO posts (id, text, media_type, media_key, media_url, scheduled_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'scheduled')
  `).bind(
    id,
    text,
    media ? 'IMAGE' : 'TEXT',
    media ? media.key : null,
    media ? media.url : null,
    scheduledAt.toISOString()
  ).run();

  return id;
}

async function updateScheduledPost(requestOrForm, env, explicitId) {
  const form = requestOrForm instanceof FormData ? requestOrForm : await requestOrForm.formData();
  const id = explicitId || String(form.get('id') || '');
  if (!id) throw new Error('缺少排程 ID');

  const existing = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!existing) throw new Error('找不到排程');
  if (existing.status === 'published' || existing.status === 'publishing') {
    throw new Error('已發布或發布中的排程不可編輯');
  }

  const text = String(form.get('text') || '').trim();
  const file = form.get('image');
  const removeImage = String(form.get('removeImage') || '') === '1';
  const rawTime = String(form.get('scheduledAtLocal') || form.get('scheduledAt') || '');
  const quick = String(form.get('quick') || '');

  if (!text && !(file instanceof File && file.size > 0) && !removeImage && !existing.media_url) {
    throw new Error('請輸入貼文文字或保留圖片');
  }

  let mediaType = existing.media_type || 'TEXT';
  let mediaKey = existing.media_key;
  let mediaUrl = existing.media_url;

  if (file instanceof File && file.size > 0) {
    const image = await storeImageIfAny(file, env, requestOrForm instanceof FormData ? null : requestOrForm);
    if (existing.media_key && env.MEDIA) await env.MEDIA.delete(existing.media_key).catch(() => {});
    mediaType = 'IMAGE';
    mediaKey = image ? image.key : null;
    mediaUrl = image ? image.url : null;
  } else if (removeImage) {
    if (existing.media_key && env.MEDIA) await env.MEDIA.delete(existing.media_key).catch(() => {});
    mediaType = 'TEXT';
    mediaKey = null;
    mediaUrl = null;
  }

  const scheduledAt = resolveScheduledAt(rawTime, quick, Date.now(), existing.scheduled_at);

  await env.DB.prepare(`
    UPDATE posts
    SET text = ?, media_type = ?, media_key = ?, media_url = ?, scheduled_at = ?, status = 'scheduled', error = NULL
    WHERE id = ?
  `).bind(text || '', mediaType, mediaKey, mediaUrl, scheduledAt.toISOString(), id).run();

  return id;
}

async function deleteScheduledPost(request, env) {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  await deleteScheduledPostById(env, id);
}

async function deleteScheduledPostById(env, id) {
  if (!id) throw new Error('缺少排程 ID');
  const row = await env.DB.prepare('SELECT media_key, status FROM posts WHERE id = ?').bind(id).first();
  if (!row) throw new Error('找不到排程');
  if (row.status === 'publishing' || row.status === 'published') {
    throw new Error('已發布或發布中的排程不可刪除');
  }
  if (row.media_key && env.MEDIA) await env.MEDIA.delete(row.media_key).catch(() => {});
  await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
}

async function serveMedia(request, env) {
  if (!env.MEDIA) return new Response('Media binding unavailable', { status: 503 });

  const path = decodeURIComponent(request.url.slice(request.url.indexOf('/media/')));
  const key = path.replace(/^\/media\//, '');
  const object = await env.MEDIA.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

async function apiListPosts(env) {
  const result = await env.DB.prepare('SELECT * FROM posts ORDER BY datetime(scheduled_at) DESC LIMIT 100').all();
  return json({ posts: result.results || [] });
}

async function publishNow(env, id) {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!post) throw new Error('找不到排程');
  if (post.status === 'published') throw new Error('此貼文已發布');

  const threadId = await publishPost(env, post);
  const permalink = await getPermalinkFromPost(env, threadId);
  return { threadId, permalink };
}

async function runScheduler(env) {
  await maybeRefreshToken(env).catch(() => {});

  const rows = (await env.DB.prepare(`
    SELECT * FROM posts
    WHERE status = 'scheduled' AND datetime(scheduled_at) <= datetime(?)
    ORDER BY datetime(scheduled_at) ASC
    LIMIT 10
  `).bind(new Date().toISOString()).all()).results || [];

  for (const post of rows) {
    try {
      const threadId = await publishPost(env, post);
      const permalink = await getPermalinkFromPost(env, threadId);
      await env.DB.prepare(`UPDATE posts SET permalink = ? WHERE id = ?`).bind(permalink, post.id).run();
    } catch (error) {
      const attempts = Number(post.attempts || 0) + 1;
      if (attempts < 3) {
        await env.DB.prepare(`
          UPDATE posts
          SET status = 'scheduled', attempts = ?, error = ?, scheduled_at = ?
          WHERE id = ?
        `).bind(attempts, safeError(error), new Date(Date.now() + attempts * 2 * 60000).toISOString(), post.id).run();
      } else {
        await env.DB.prepare(`
          UPDATE posts
          SET status = 'failed', attempts = ?, error = ?
          WHERE id = ?
        `).bind(attempts, safeError(error), post.id).run();
      }
    }
  }
}

async function publishPost(env, post) {
  const token = await getSetting(env, 'threads_access_token');
  if (!token) throw new Error('尚未連接 Threads 帳號');

  const claimed = await env.DB.prepare(`
    UPDATE posts SET status = 'publishing', error = NULL
    WHERE id = ? AND status IN ('scheduled', 'failed')
  `).bind(post.id).run();

  if (!claimed.meta?.changes) {
    const current = await env.DB.prepare('SELECT status, thread_id FROM posts WHERE id = ?').bind(post.id).first();
    if (current?.status === 'published') return current.thread_id;
    throw new Error('排程目前不可發布');
  }

  try {
    const params = new URLSearchParams({
      access_token: token,
      media_type: post.media_type === 'IMAGE' ? 'IMAGE' : 'TEXT'
    });

    if (post.text) params.set('text', post.text);
    if (post.media_type === 'IMAGE' && post.media_url) params.set('image_url', post.media_url);

    const created = await fetch(`${GRAPH}/me/threads?${params}`, { method: 'POST' });
    const createdJson = await created.json();
    if (!created.ok || !createdJson.id) {
      throw new Error(createdJson?.error?.message || '建立 Threads 容器失敗');
    }

    if (post.media_type === 'IMAGE') {
      await waitForContainer(token, createdJson.id);
    }

    const publishResponse = await fetch(`${GRAPH}/me/threads_publish?${new URLSearchParams({
      access_token: token,
      creation_id: createdJson.id
    })}`, { method: 'POST' });

    const publishJson = await publishResponse.json();
    if (!publishResponse.ok || !publishJson.id) {
      throw new Error(publishJson?.error?.message || 'Threads 發布失敗');
    }

    const permalink = await getPermalinkFromPost(env, String(publishJson.id));
    await env.DB.prepare(`
      UPDATE posts SET status = 'published', thread_id = ?, permalink = ?, published_at = ?, attempts = attempts + 1, error = NULL
      WHERE id = ?
    `).bind(String(publishJson.id), permalink, new Date().toISOString(), post.id).run();

    return String(publishJson.id);
  } catch (error) {
    await env.DB.prepare(`
      UPDATE posts SET status = 'failed', attempts = attempts + 1, error = ?
      WHERE id = ?
    `).bind(safeError(error), post.id).run();
    throw error;
  }
}

async function getPermalinkFromPost(env, threadId) {
  const token = await getSetting(env, 'threads_access_token');
  if (!threadId) return '';
  if (!token) return `https://www.threads.net/post/${encodeURIComponent(threadId)}`;

  try {
    const url = `${GRAPH}/${encodeURIComponent(threadId)}?fields=permalink&access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url);
    const data = await response.json();
    return response.ok && data.permalink ? data.permalink : `https://www.threads.net/post/${encodeURIComponent(threadId)}`;
  } catch {
    return `https://www.threads.net/post/${encodeURIComponent(threadId)}`;
  }
}

async function waitForContainer(token, id) {
  for (let index = 0; index < 8; index += 1) {
    const response = await fetch(`${GRAPH}/${encodeURIComponent(id)}?fields=status,error_message&access_token=${encodeURIComponent(token)}`);
    const data = await response.json();
    if (response.ok) {
      const status = String(data.status || '').toUpperCase();
      if (status === 'FINISHED' || status === 'PUBLISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new Error(data.error_message || `媒體處理失敗：${status}`);
      }
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

  const timeLeft = new Date(expiresAt).getTime() - Date.now();
  const sinceLastRefresh = lastRefresh ? Date.now() - new Date(lastRefresh).getTime() : Infinity;
  if (timeLeft > 10 * 24 * 60 * 60 * 1000 || sinceLastRefresh < 24 * 60 * 60 * 1000) return;

  const params = new URLSearchParams({ grant_type: 'th_refresh_token', access_token: token });
  const response = await fetch(`${OAUTH_HOST}/refresh_access_token?${params}`);
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data?.error?.message || 'Token 刷新失敗');
  }

  await setSetting(env, 'threads_access_token', data.access_token);
  await setSetting(env, 'token_expires_at', new Date(Date.now() + Number(data.expires_in || 5184000) * 1000).toISOString());
  await setSetting(env, 'token_last_refresh', new Date().toISOString());
}

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row?.value || null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(key, String(value)).run();
}

async function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;

  const supplied = request.headers.get('x-admin-key') || '';
  if (supplied === env.ADMIN_KEY) return true;

  const session = readCookie(request, 'admin_session');
  if (!session) return false;

  const expected = await adminSession(env.ADMIN_KEY);
  return session === expected;
}

async function adminSession(secret) {
  const data = new TextEncoder().encode('threads-scheduler:' + secret);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function resolveScheduledAt(rawTime, quick, now, fallbackIso) {
  if (quick) {
    const offsetMinutes = {
      '15': 15,
      '30': 30,
      '60': 60
    }[quick];

    if (offsetMinutes) {
      return new Date(now + offsetMinutes * 60 * 1000);
    }

    if (quick === 'tonight20') {
      const local = new Date(now);
      const parts = getTaipeiParts(local);
      let target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 20 - 8, 0, 0));
      if (target.getTime() <= now) target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
      return target;
    }

    if (quick === 'tomorrow9') {
      const local = new Date(now);
      const parts = getTaipeiParts(local);
      return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 9 - 8, 0, 0));
    }
  }

  if (!rawTime) {
    if (fallbackIso) return new Date(fallbackIso);
    throw new Error('請選擇台灣時間');
  }

  const date = rawTime.includes('T') ? parseTaipeiLocal(rawTime) : parseTaipeiLocalDateTime(rawTime);
  if (Number.isNaN(date.getTime())) throw new Error('排程時間格式錯誤');
  if (date.getTime() <= now) throw new Error('排程時間必須是未來的台灣時間');
  return date;
}

function parseTaipeiLocal(rawValue) {
  const match = String(rawValue).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return new Date('invalid');
  const [, year, month, day, hour, minute, second = '0'] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) + 8, Number(minute), Number(second)));
}

function parseTaipeiLocalDateTime(rawValue) {
  return parseTaipeiLocal(rawValue.replace(' ', 'T'));
}

function getTaipeiParts(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year || '0'),
    month: Number(map.month || '1'),
    day: Number(map.day || '1'),
    hour: Number(map.hour || '0'),
    minute: Number(map.minute || '0'),
    second: Number(map.second || '0')
  };
}

async function storeImageIfAny(file, env, request) {
  if (!(file instanceof File) || !file.size) return null;
  if (!env.MEDIA) throw new Error('尚未設定 R2 MEDIA binding');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('圖片不可超過 10 MB');
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error('只支援 JPG / PNG 圖片');

  const extension = file.type === 'image/png' ? '.png' : '.jpg';
  const key = `uploads/${crypto.randomUUID()}${extension}`;
  const stream = file.stream ? file.stream() : file.arrayBuffer().then((buffer) => new Response(buffer).body);
  await env.MEDIA.put(key, stream, {
    httpMetadata: {
      contentType: file.type,
      cacheControl: 'public, max-age=31536000, immutable'
    }
  });

  return {
    key,
    url: `${getBaseUrl(request, env)}/media/${encodeURIComponent(key)}`
  };
}

function getBaseUrl(request, env) {
  return String(env.PUBLIC_BASE_URL || (request ? new URL(request.url).origin : 'https://example.com')).replace(/\/$/, '');
}

function readCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const parts = cookie.split(';').map((entry) => entry.trim());
  const match = parts.find((part) => part.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : '';
}

function safeError(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 800);
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fTime(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function renderApp({ appName, loggedIn, username, posts, requestUrl, statusMessage }) {
  const message = statusMessage ? `<div class="msg">${escapeHtml(statusMessage)}</div>` : '';
  const listHtml = posts.length ? posts.map(renderPostCard).join('') : '<p class="muted">目前沒有排程。</p>';

  if (!loggedIn) {
    return `<!doctype html>
      <html lang="zh-Hant">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
        <title>${escapeHtml(appName)}</title>
        <style>${baseStyles()}</style>
      </head>
      <body>
        <main class="wrap">
          <section class="card">
            <h1>🧵 ${escapeHtml(appName)}</h1>
            <p class="muted">請輸入 ADMIN_KEY 登入後管理排程。</p>
            <form method="post" action="/login">
              <label for="adminKey">管理密碼</label>
              <div class="stack-mobile">
                <input id="adminKey" name="adminKey" type="password" placeholder="輸入 ADMIN_KEY" required />
                <button class="primary" type="submit">登入</button>
              </div>
            </form>
          </section>
        </main>
      </body>
      </html>`;
  }

  const editId = new URL(requestUrl).searchParams.get('edit');
  const editingPost = posts.find((post) => post.id === editId && ['scheduled', 'failed'].includes(post.status));

  const formAction = editingPost ? '/edit' : '/schedule';
  const formHidden = editingPost ? `<input type="hidden" name="id" value="${escapeHtml(editingPost.id)}" />` : '';
  const imagePreview = editingPost && editingPost.media_url ? `<div class="preview-wrap"><img class="preview" src="${escapeHtml(editingPost.media_url)}" alt="目前圖片" /><label class="checkbox"><input type="checkbox" name="removeImage" value="1" /> 移除目前圖片</label></div>` : '';

  const form = `
    <section class="card">
      <h2>${editingPost ? '編輯排程' : '新增排程'}</h2>
      <form method="post" action="${formAction}" enctype="multipart/form-data">
        ${formHidden}
        <label>貼文文字</label>
        <textarea name="text" placeholder="輸入 Threads 貼文內容…">${escapeHtml(editingPost ? editingPost.text || '' : '')}</textarea>

        <label>單張圖片（JPG / PNG，最多 10 MB）</label>
        <input type="file" name="image" accept="image/jpeg,image/png" />
        ${imagePreview}

        <label>發佈時間（台灣時間 Asia/Taipei）</label>
        <input type="datetime-local" name="scheduledAtLocal" />

        <div class="quick-grid">
          <button type="submit" name="quick" value="15">15 分鐘後</button>
          <button type="submit" name="quick" value="30">30 分鐘後</button>
          <button type="submit" name="quick" value="60">1 小時後</button>
          <button type="submit" name="quick" value="tonight20">今晚 20:00</button>
          <button type="submit" name="quick" value="tomorrow9">明天 09:00</button>
        </div>

        <div class="action-row">
          <button class="primary" type="submit">${editingPost ? '儲存修改' : '加入排程'}</button>
          ${editingPost ? '<a class="secondary btnlink" href="/">取消編輯</a>' : '<a class="secondary btnlink" href="/connect">' + (username ? '重新連接 Threads' : '連接 Threads') + '</a>'}
        </div>
      </form>
    </section>
  `;

  return `<!doctype html>
    <html lang="zh-Hant">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
      <meta name="theme-color" content="#111111" />
      <title>${escapeHtml(appName)}</title>
      <style>${baseStyles()}</style>
    </head>
    <body>
      <main class="wrap">
        <section class="card">
          <h1>🧵 ${escapeHtml(appName)}</h1>
          <p class="muted">全程以台灣時間 Asia/Taipei 運作</p>
          <div class="status${username ? ' ok' : ' bad'}">
            ${username ? '已連接 @' + escapeHtml(username) : '尚未連接 Threads'}
          </div>
          <div class="action-row">
            <a class="primary btnlink" href="/connect">${username ? '重新連接 Threads' : '連接 Threads'}</a>
          </div>
        </section>

        ${message}
        ${form}

        <section class="card">
          <h2>排程列表</h2>
          ${listHtml}
        </section>
      </main>
    </body>
    </html>`;
}

function renderPostCard(post) {
  const status = escapeHtml(post.status || 'scheduled');
  const text = escapeHtml(post.text || '(只有圖片)');
  const image = post.media_url ? `<img class="preview" src="${escapeHtml(post.media_url)}" alt="排程圖片" loading="lazy" />` : '';
  const scheduleTime = escapeHtml(fTime(post.scheduled_at));
  const publishTime = post.published_at ? escapeHtml(fTime(post.published_at)) : '—';
  const attempts = escapeHtml(post.attempts || 0);
  const error = post.error ? `<div class="msg err">${escapeHtml(post.error)}</div>` : '';
  const permalinkLink = post.permalink ? `<a class="primary btnlink" href="${escapeHtml(post.permalink)}" target="_blank" rel="noopener">查看 Threads 貼文</a>` : '';
  const canEdit = ['scheduled', 'failed'].includes(post.status);
  const editLink = canEdit ? `<a class="secondary btnlink" href="/?edit=${encodeURIComponent(post.id)}">編輯</a>` : '';
  const deleteForm = canEdit ? `
    <form method="post" action="/delete" class="inline-form">
      <input type="hidden" name="id" value="${escapeHtml(post.id)}" />
      <button class="danger" type="submit" onclick="return confirm('確定刪除此排程？')">刪除</button>
    </form>
  ` : '';
  const retryForm = post.status === 'failed' ? `
    <form method="post" action="/api/posts/${encodeURIComponent(post.id)}/publish" class="inline-form">
      <button class="secondary" type="submit">重新發布</button>
    </form>
  ` : '';

  return `
    <article class="item">
      <div class="post-head">
        <span class="pill ${status}">${status}</span>
      </div>
      <div class="post-text">${text}</div>
      ${image}
      <div class="meta-row">
        <span>排程：${scheduleTime}</span>
        <span>發布：${publishTime}</span>
        <span>嘗試：${attempts}</span>
      </div>
      ${error}
      <div class="action-row">
        ${permalinkLink}
        ${editLink}
        ${retryForm}
        ${deleteForm}
      </div>
    </article>
  `;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function baseStyles() {
  return `
    :root {
      --bg: #f4f5f7;
      --card: #ffffff;
      --text: #111827;
      --muted: #667085;
      --line: #e5e7eb;
      --primary: #111827;
      --secondary: #f3f4f6;
      --success: #047857;
      --warning: #b45309;
      --danger: #b42318;
      --danger-bg: #fff1f2;
      --ok-bg: #ecfdf5;
      --bad-bg: #fef3f2;
      --shadow: rgba(17, 24, 39, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .wrap {
      max-width: 860px;
      margin: 0 auto;
      padding: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
      margin-bottom: 16px;
      box-shadow: 0 8px 20px var(--shadow);
    }
    h1, h2 {
      margin: 0 0 12px;
    }
    h1 { font-size: clamp(1.5rem, 2vw, 2rem); }
    h2 { font-size: 1.1rem; }
    label {
      display: block;
      font-weight: 700;
      margin: 12px 0 8px;
    }
    input, textarea, button {
      font: inherit;
      border-radius: 12px;
      border: 1px solid #d0d5dd;
      padding: 12px 14px;
      width: 100%;
    }
    textarea {
      min-height: 140px;
      resize: vertical;
    }
    button, .btnlink {
      display: inline-block;
      width: auto;
      text-decoration: none;
      text-align: center;
      cursor: pointer;
    }
    .primary {
      background: var(--primary);
      color: #ffffff;
      border-color: var(--primary);
    }
    .secondary {
      background: var(--secondary);
      color: var(--text);
      border-color: var(--line);
    }
    .danger {
      background: var(--danger-bg);
      color: var(--danger);
      border-color: #fecaca;
    }
    .btnlink {
      padding: 10px 14px;
      font-size: 0.95rem;
    }
    .stack-mobile {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .stack-mobile input {
      flex: 1;
    }
    .action-row,
    .quick-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .quick-grid button,
    .action-row > * {
      flex: 1 1 160px;
    }
    .status {
      display: inline-block;
      font-weight: 700;
      padding: 8px 12px;
      border-radius: 999px;
      margin-bottom: 8px;
    }
    .status.ok {
      background: var(--ok-bg);
      color: var(--success);
    }
    .status.bad {
      background: var(--bad-bg);
      color: var(--danger);
    }
    .muted {
      color: var(--muted);
    }
    .item {
      border-top: 1px solid var(--line);
      padding-top: 16px;
      margin-top: 16px;
    }
    .post-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .pill {
      display: inline-block;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 0.8rem;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.03em;
      background: #eef2ff;
      color: var(--primary);
    }
    .pill.scheduled { background: #eff6ff; color: #1d4ed8; }
    .pill.publishing { background: #fff7ed; color: var(--warning); }
    .pill.published { background: #ecfdf5; color: var(--success); }
    .pill.failed { background: #fef2f2; color: var(--danger); }
    .post-text {
      white-space: pre-wrap;
      margin: 10px 0;
      word-break: break-word;
    }
    .preview-wrap {
      margin-top: 12px;
    }
    .preview {
      display: block;
      width: 100%;
      max-height: 360px;
      object-fit: contain;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: #f9fafb;
      margin: 10px 0;
    }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      color: var(--muted);
      font-size: 0.85rem;
      margin-top: 8px;
    }
    .msg {
      padding: 12px 14px;
      background: #ecfdf5;
      color: #065f46;
      border: 1px solid #a7f3d0;
      border-radius: 12px;
      margin-top: 12px;
      word-break: break-word;
    }
    .msg.err {
      background: #fff1f2;
      color: var(--danger);
      border-color: #fecdd3;
    }
    .checkbox {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
    }
    .checkbox input {
      width: auto;
      margin: 0;
    }
    .inline-form {
      display: inline;
    }
    @media (max-width: 560px) {
      .stack-mobile {
        flex-direction: column;
        align-items: stretch;
      }
      .quick-grid .btnlink,
      .quick-grid button,
      .action-row > * {
        flex: 1 1 100%;
      }
      .meta-row {
        display: block;
      }
      .meta-row span {
        display: block;
        margin: 4px 0;
      }
    }
  `;
}

