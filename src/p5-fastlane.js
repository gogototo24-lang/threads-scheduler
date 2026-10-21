// P5 scoped fast lane. Does not expose ADMIN_KEY or the Threads OAuth token.
// POST remains secret-authenticated by scoutGuarded in ai-worker.js.
const SAFE_CATEGORY = new Set(['entertainment','culture','cats','puppetry','lifestyle','technology','tourism','transport','music']);
const PUBLIC_API = '/api/factory/p5/fastlane';
const BLOCKED = /選舉|罷免|投票|政黨|候選人|政治|兩岸|戰爭|詐騙|死亡|傷亡|醫療建議|仇恨|性侵|裸露|私訊/i;

export function validateFastLaneSubmission(body, currentMs = Date.now()) {
  if (!body || typeof body !== 'object') throw new Error('缺少 JSON');
  const sourceUrl = String(body.source_url || '').trim();
  let source;
  try { source = new URL(sourceUrl); } catch { throw new Error('需要 HTTPS 來源網址'); }
  if (source.protocol !== 'https:' || source.username || source.password) throw new Error('需要 HTTPS 來源網址');
  const category = String(body.category || '').trim().toLowerCase();
  if (!SAFE_CATEGORY.has(category)) throw new Error('此主題不符合非政治快速發布類別，需人工審核');
  const text = String(body.text || '').trim();
  if (text.length < 20 || Array.from(text).length > 500) throw new Error('原創貼文字數需為 20–500');
  if (BLOCKED.test(text+' '+String(body.title||''))) throw new Error('高風險／政治議題不得透過快速通道發布');
  const sourceHost = source.hostname.toLowerCase();
  // A reviewable original caption must acknowledge its source, rather than passing off copied media.
  if (!text.includes(sourceUrl)) throw new Error('原創貼文須包含完整來源網址');
  const timestamp = Date.parse(String(body.verified_at || ''));
  if (!Number.isFinite(timestamp) || timestamp > currentMs + 5*60*1000 ||
      currentMs - timestamp > 2*60*60*1000) {
    throw new Error('來源核實時間需在最近兩小時內，逾時須重新核實');
  }
  const vMethod = String(body.verification_method || '');
  if (!['official','independent'].includes(vMethod)) {
    throw new Error('缺少官方或雙來源核實方式');
  }
  const evidence = Array.isArray(body.verification_urls) ? body.verification_urls : [];
  if (vMethod === 'independent' && evidence.length < 2) throw new Error('新聞須有兩個獨立核實來源');
  if (vMethod === 'independent') {
    const hosts = evidence.map(u => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ''; } });
    if (new Set(hosts).size < 2) throw new Error('雙來源核實需使用不同來源網站');
  }
  if (vMethod === 'official' && evidence.length < 1) throw new Error('官方核實需提供官方公告 URL');
  for (const value of evidence.slice(0,6)) {
    let u; try { u = new URL(String(value)); } catch { throw new Error('核實來源網址格式錯誤'); }
    if (u.protocol !== 'https:') throw new Error('核實來源必須為 HTTPS');
  }
  if (body.contains_unlicensed_media || body.political || body.high_risk || body.review_required) {
    throw new Error('這筆內容需人工審核');
  }
  return {
    source_url:sourceUrl, source_host:sourceHost, category,
    text, verified_at:new Date(timestamp).toISOString(),
    verification_method:vMethod, verification_urls:evidence.slice(0,6).map(String),
    title:String(body.title||'').trim().slice(0,120)
  };
}

async function hashId(source) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  const hex = [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return 'p5fast-'+hex.slice(0,40);
}

async function readAction(env,id) {
  const row = await env.DB.prepare(
    "SELECT id,status,external_thread_id,permalink,error,created_at,sent_at FROM social_actions WHERE id=?"
  ).bind(id).first();
  return row ? {
    action_id:row.id, status:row.status,
    thread_id:row.external_thread_id||null,
    permalink:row.permalink||null,
    error:row.error||null,created_at:row.created_at,
    sent_at:row.sent_at||null,
    published:row.status==='sent' && !!row.external_thread_id
  } : null;
}

export async function fastLaneHealth(env) {
  const stored = await env.DB.prepare("SELECT value FROM settings WHERE key='threads_access_token'").first().catch(()=>null);
  const recent = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM social_actions WHERE created_at >= datetime('now','-24 hours') GROUP BY status"
  ).all().catch(()=>({results:[]}));
  return {
    version:'p5-fastlane.v1',
    worker_ready:!!env.DB,
    scout_key_configured:!!String(env.P5_SCOUT_KEY||''),
    admin_key_configured:!!String(env.ADMIN_KEY||''),
    threads_token_stored:!!stored?.value,
    threads_token_validated_live:false, // never misrepresent local secret as OAuth validation
    fastlane_requires_scoped_key:true,
    last24h_action_counts:recent.results||[],
    publisher:'Cloudflare Worker → Threads official API',
    metricool_new_posts:false,
    // A secret must be configured in Cloudflare AND supplied by a trusted runtime.
    note:'HTTP 401 means no authorized scout/admin credential; Ready != permission to publish.'
  };
}

export async function fastLaneSubmit(request,env,dispatchAction) {
  const data = validateFastLaneSubmission(await request.json());
  const id = await hashId(data.source_url);
  const old = await readAction(env,id);
  if (old) return {ok:true,deduplicated:true,...old};

  // Atomic idempotent insert; another request may win this race.
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO social_actions " +
    "(id,candidate_id,reply_draft_id,platform,action_type,target_thread_id,text,status,risk_level,scheduled_at,created_at,updated_at) " +
    "VALUES (?,NULL,NULL,'threads','original_post',NULL,?,'queued','low',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
  ).bind(id,data.text).run();
  if (!result.meta?.changes) return {ok:true,deduplicated:true,...await readAction(env,id)};

  // Record source & verification facts for an auditable handoff.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO social_cross_platform_items " +
    "(id,source_platform,source_url,source_author,title,source_summary,content_type,metrics_json," +
    "heat_score,relevance_score,risk_level,universe,remix_text,status,action_id,created_at,updated_at) " +
    "VALUES (?,'web',?,'',?,?,'post',?,90,90,'low','喵台灣宇宙',?,'queued',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
  ).bind('evidence-'+id,data.source_url,data.title,
    'verified:'+data.verification_method,
    JSON.stringify({verified_at:data.verified_at,verification_urls:data.verification_urls,category:data.category}),
    data.text,id).run();

  // Dispatch immediately through the same P5 rate/safety guarded executor.
  const outcome = await dispatchAction(id);
  return {ok:true,deduplicated:false,...await readAction(env,id),dispatch:outcome};
}

export async function fastLaneActionStatus(env,id) {
  if (!/^p5fast-[a-f0-9]{40}$/.test(String(id))) throw new Error('無效的任務 ID');
  const row=await readAction(env,id);
  if(!row)throw new Error('任務不存在');
  return {ok:true,...row};
}
