// Threads VIDEO publisher: asynchronous container preparation and conservative publication.
// No network request is made merely by importing this module.
const GRAPH = 'https://graph.threads.net/v1.0';
const POLL_INTERVAL_MS = 30_000;
const MAX_CONTAINER_AGE_MS = 23 * 60 * 60 * 1000;

export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

export function validateVideoFile(file) {
  if (!file || !Number.isFinite(Number(file.size)) || file.size < 1) {
    throw new Error('請選擇 MP4 影片');
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error('目前單支影片限 25 MB，請先壓縮後再上傳');
  }
  if (file.type !== 'video/mp4') {
    throw new Error('只支援 video/mp4；請先轉為 H.264 MP4');
  }
  return true;
}

export function classifyVideoContainerStatus(status) {
  switch (String(status || '').toUpperCase()) {
    case 'FINISHED': return 'ready';
    case 'IN_PROGRESS': return 'waiting';
    case 'ERROR':
    case 'EXPIRED': return 'failed';
    case 'PUBLISHED': return 'already_published';
    default: return 'unknown';
  }
}

export function buildVideoContainerParams(token, post) {
  if (!token) throw new Error('尚未連接 Threads 帳號');
  if (!post || post.media_type !== 'VIDEO') throw new Error('不是 VIDEO 貼文');
  const caption = String(post.text || '');
  if (caption.length > 500) throw new Error('Threads 文字超過 500 字元');
  let url;
  try { url = new URL(String(post.media_url || '')); }
  catch { throw new Error('缺少有效的影片網址'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('影片必須使用可公開存取的 HTTPS 網址');
  }
  const params = new URLSearchParams({
    access_token: token,
    media_type: 'VIDEO',
    video_url: url.toString()
  });
  if (caption) params.set('text', caption);
  return params;
}

async function getToken(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='threads_access_token'").first();
  if (!row?.value) throw new Error('Threads OAuth 尚未完成連接');
  return String(row.value);
}

async function decode(response) {
  return response.json().catch(() => ({}));
}

function graphError(response, data, stage) {
  return new Error(String(data?.error?.message || data?.error_message || stage + ' HTTP ' + response.status).slice(0, 500));
}

async function markFailed(env, id, error) {
  await env.DB.prepare(
    "UPDATE posts SET status='failed', error=?, attempts=attempts+1 WHERE id=? AND status IN ('preparing','processing')"
  ).bind(String(error?.message || error).slice(0, 700), id).run();
}

async function nextPoll(env, id, error, delayMs = POLL_INTERVAL_MS) {
  const next = new Date(Date.now() + delayMs).toISOString();
  await env.DB.prepare(
    "UPDATE posts SET video_next_check_at=?, error=? WHERE id=? AND status='processing'"
  ).bind(next, error ? String(error).slice(0, 500) : null, id).run();
}

export async function beginVideoPost(env, post) {
  if (post.media_type !== 'VIDEO') throw new Error('不支援的媒體類型');
  const token = await getToken(env);
  const params = buildVideoContainerParams(token, post);
  // Claim before creating a remote container, avoiding parallel requests.
  const claim = await env.DB.prepare(
    "UPDATE posts SET status='preparing', error=NULL WHERE id=? AND status IN ('scheduled','failed') AND media_type='VIDEO'"
  ).bind(post.id).run();
  if (!claim.meta?.changes) throw new Error('影片排程已開始處理或不允許重複發布');

  try {
    const response = await fetch(GRAPH + '/me/threads?' + params, { method: 'POST' });
    const data = await decode(response);
    if (!response.ok || !data.id) throw graphError(response, data, '建立影片容器失敗');

    const started = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE posts SET status='processing', video_container_id=?, video_started_at=?, video_next_check_at=?, video_publish_requested_at=NULL, error=NULL WHERE id=? AND status='preparing'"
    ).bind(String(data.id), started, started, post.id).run();
    return { status: 'processing', postId: post.id, creationId: String(data.id) };
  } catch (error) {
    await markFailed(env, post.id, error);
    throw error;
  }
}

async function processOneVideo(env, post, token) {
  if (!post.video_container_id) {
    await markFailed(env, post.id, '缺少影片容器 ID');
    return 'failed';
  }
  const start = Date.parse(post.video_started_at || post.created_at || '');
  if (Number.isFinite(start) && Date.now() - start > MAX_CONTAINER_AGE_MS) {
    await markFailed(env, post.id, '影片容器接近 Threads 到期時間，請重新排程');
    return 'failed';
  }

  let response;
  let data;
  try {
    response = await fetch(GRAPH + '/' + encodeURIComponent(post.video_container_id) +
      '?fields=status,error_message&access_token=' + encodeURIComponent(token));
    data = await decode(response);
  } catch (error) {
    await nextPoll(env, post.id, '暫時無法檢查影片容器：' + error, 60_000);
    return 'waiting';
  }
  if (!response.ok) {
    await nextPoll(env, post.id, graphError(response, data, '查詢容器失敗').message, 60_000);
    return 'waiting';
  }
  const decision = classifyVideoContainerStatus(data.status);
  if (decision === 'waiting' || decision === 'unknown') {
    await nextPoll(env, post.id, decision === 'unknown' ? '未知的處理狀態：' + data.status : null);
    return 'waiting';
  }
  if (decision === 'already_published') {
    await env.DB.prepare(
      "UPDATE posts SET status='publish_unknown',error=? WHERE id=? AND status='processing'"
    ).bind('Threads 容器已顯示 PUBLISHED；請人工確認是否已發布，禁止重試', post.id).run();
    return 'unknown';
  }
  if (decision === 'failed') {
    await markFailed(env, post.id, data.error_message || '影片處理失敗：' + data.status);
    return 'failed';
  }

  // The publishing request may succeed even if the response is lost.
  // Once claimed, never auto retry a potentially published VIDEO container.
  const claim = await env.DB.prepare(
    "UPDATE posts SET status='publishing', video_publish_requested_at=?, error=NULL WHERE id=? AND status='processing'"
  ).bind(new Date().toISOString(), post.id).run();
  if (!claim.meta?.changes) return 'waiting';
  try {
    const published = await fetch(GRAPH + '/me/threads_publish?' + new URLSearchParams({
      access_token: token,
      creation_id: post.video_container_id
    }), { method: 'POST' });
    const result = await decode(published);
    if (!published.ok || !result.id) throw graphError(published, result, '發布影片失敗');

    let permalink = null;
    try {
      const linkResponse = await fetch(GRAPH + '/' + encodeURIComponent(result.id) +
        '?fields=permalink&access_token=' + encodeURIComponent(token));
      const link = await decode(linkResponse);
      if (linkResponse.ok && typeof link.permalink === 'string') permalink = link.permalink;
    } catch { /* Link can be retrieved after publication. */ }

    await env.DB.prepare(
      "UPDATE posts SET status='published', thread_id=?, permalink=?, published_at=?, attempts=attempts+1, error=NULL WHERE id=? AND status='publishing'"
    ).bind(String(result.id), permalink, new Date().toISOString(), post.id).run();
    return 'published';
  } catch (error) {
    await env.DB.prepare(
      "UPDATE posts SET status='publish_unknown', error=? WHERE id=? AND status='publishing'"
    ).bind('Threads 發布結果不明，禁止自動重試；請先查對方帳號是否已發文：' +
      String(error?.message || error).slice(0, 400), post.id).run();
    return 'unknown';
  }
}

export async function processVideoPosts(env) {
  const due = (await env.DB.prepare(
    "SELECT * FROM posts WHERE media_type='VIDEO' AND status='processing' AND (video_next_check_at IS NULL OR video_next_check_at<=?) ORDER BY video_started_at LIMIT 5"
  ).bind(new Date().toISOString()).all()).results || [];
  if (!due.length) return { checked: 0, published: 0, failed: 0, unknown: 0 };
  const token = await getToken(env);
  const result = { checked: 0, published: 0, failed: 0, unknown: 0 };
  for (const post of due) {
    const outcome = await processOneVideo(env, post, token);
    result.checked += 1;
    if (outcome === 'published') result.published += 1;
    if (outcome === 'failed') result.failed += 1;
    if (outcome === 'unknown') result.unknown += 1;
  }
  return result;
}
