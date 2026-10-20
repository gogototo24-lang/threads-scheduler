// CatPaw Universe HQ v1: durable human-operated control plane.
// All writes are MOCK bookkeeping; this module never invokes paid providers
// or social publishing endpoints and never changes production job approvals.

export const HQ_PIPELINES = Object.freeze(['A','B','C','D']);
export const HQ_ROLES = Object.freeze(['HQ','A','B','C','D','W']);
const ORIGIN = 'https://gogototo24-lang.github.io';
const SOURCE = 'catpaw-hq-v1';

export function validateMockJob(raw) {
  if (!raw || !HQ_PIPELINES.includes(raw.pipeline_id)) throw new Error('產線只能是 A/B/C/D');
  if (raw.mode && raw.mode !== 'mock') throw new Error('總部目前僅允許 Mock 任務');
  if (raw.paid_enabled || raw.publish_enabled || raw.publish || Number(raw.budget_max_twd || 0) !== 0) {
    throw new Error('付費／發布閘門鎖定，Mock 任務成本必須為 0');
  }
  const title = String(raw.title || '').trim();
  const brief = String(raw.brief || '').trim();
  const key = String(raw.idempotency_key || '').trim();
  if (!title || title.length > 120) throw new Error('標題需為 1–120 字元');
  if (!brief || brief.length > 2000) throw new Error('任務摘要需為 1–2000 字元');
  if (!/^[a-zA-Z0-9:_-]{8,120}$/.test(key)) throw new Error('請提供有效的去重鍵');
  return { pipeline_id: raw.pipeline_id, title, brief, idempotency_key: key };
}

export function validateRoleUpdate(role, data) {
  if (!HQ_ROLES.includes(role)) throw new Error('未知廠長席位');
  const status = String(data?.status || '');
  if (!['candidate','interviewing','appointed'].includes(status)) throw new Error('不允許的任命狀態');
  const name = String(data?.appointed_name || '').trim();
  if (name.length > 80) throw new Error('名稱不可超過 80 字元');
  if (status === 'appointed' && !name) throw new Error('請輸入已任命廠長名稱');
  if (data?.connector_verified === true || data?.paid_enabled || data?.publish_enabled) {
    throw new Error('人工任命不代表工具已授權連線');
  }
  return { role_id: role, status, appointed_name: name || null };
}

function allowedOrigin(req) {
  const origin = req.headers.get('origin') || '';
  return origin === ORIGIN || origin === new URL(req.url).origin ? origin : '';
}

function headers(req, json = true) {
  const h = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  if (json) h.set('content-type', 'application/json; charset=utf-8');
  const origin = allowedOrigin(req);
  if (origin) {
    h.set('access-control-allow-origin', origin);
    h.set('vary', 'Origin');
    h.set('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
    h.set('access-control-allow-headers', 'content-type, x-admin-key');
    h.set('access-control-max-age', '600');
  }
  return h;
}

function answer(req, value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: headers(req) });
}

async function authorized(req, env) {
  // CORS does not grant permissions; only the existing Worker admin secret does.
  const expected = String(env.ADMIN_KEY || '');
  const provided = String(req.headers.get('x-admin-key') || '');
  if (!expected || !provided) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i=0;i<a.length;i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readJson(req) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new Error('只接受 JSON 格式');
  const length = Number(req.headers.get('content-length') || 0);
  if (length > 16_384) throw new Error('要求內容過大');
  const text = await req.text();
  if (text.length > 16_384) throw new Error('要求內容過大');
  try { return JSON.parse(text); } catch { throw new Error('JSON 解析錯誤'); }
}

async function audit(env, action, fields = {}) {
  await env.DB.prepare(
    'INSERT INTO hq_audit (id,action,role_id,job_id,details_json) VALUES (?,?,?,?,?)'
  ).bind(crypto.randomUUID(), action, fields.role_id || null, fields.job_id || null,
    JSON.stringify(fields.details || {})).run();
}

async function publicOverview(env) {
  const roles = await env.DB.prepare(
    "SELECT role_id,status,connector_verified FROM hq_roles ORDER BY role_id"
  ).all();
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM factory_jobs WHERE source_system=?"
  ).bind(SOURCE).first();
  return {
    version: 'hq.v1', ready: true, phase: 'foundation',
    storage: 'Cloudflare D1',
    mock_only: true, paid_enabled: false, publish_enabled: false,
    actor_count: (roles.results || []).filter(r=>r.status==='appointed').length,
    connected_agents: (roles.results || []).filter(r=>r.connector_verified===1).length,
    mock_jobs: Number(count?.n || 0),
    canon: '貓掌江湖中央資料庫 v3：角色圖須經審核才可生成；缺漏不可猜測',
    media_publishing: 'threads-scheduler；總部 Mock 不呼叫發布 API'
  };
}

async function privateState(env) {
  const roleRows = await env.DB.prepare(
    'SELECT role_id,floor_name,suggested_provider,duty,status,appointed_name,connector_verified,updated_at FROM hq_roles ORDER BY CASE role_id WHEN \'HQ\' THEN 0 WHEN \'A\' THEN 1 WHEN \'B\' THEN 2 WHEN \'C\' THEN 3 WHEN \'D\' THEN 4 ELSE 5 END'
  ).all();
  const jobRows = await env.DB.prepare(
    "SELECT id,pipeline_id,status,mode,input_json,actual_cost,budget_max,created_at,updated_at FROM factory_jobs WHERE source_system=? ORDER BY created_at DESC LIMIT 40"
  ).bind(SOURCE).all();
  const logRows = await env.DB.prepare(
    'SELECT action,role_id,job_id,details_json,created_at FROM hq_audit ORDER BY created_at DESC LIMIT 30'
  ).all();
  return {
    ...(await publicOverview(env)),
    roles: roleRows.results || [],
    jobs: (jobRows.results || []).map(row => {
      let input = {};
      try { input = JSON.parse(row.input_json || '{}'); } catch {}
      return {
        job_id: row.id, pipeline_id: row.pipeline_id,
        title: input.title || '', brief: input.brief || '',
        status: row.status, mode: row.mode,
        actual_cost_twd: Number(row.actual_cost || 0),
        budget_max_twd: Number(row.budget_max || 0),
        created_at: row.created_at, updated_at: row.updated_at
      };
    }),
    recent_events: logRows.results || [],
    external_providers_connected: false,
    last_sync: new Date().toISOString()
  };
}

async function hireRole(env, role, payload) {
  const info = validateRoleUpdate(role, payload);
  const exists = await env.DB.prepare('SELECT role_id FROM hq_roles WHERE role_id=?').bind(role).first();
  if (!exists) throw new Error('廠長席位尚未建立');
  await env.DB.prepare(
    'UPDATE hq_roles SET status=?,appointed_name=?,connector_verified=0,updated_at=CURRENT_TIMESTAMP WHERE role_id=?'
  ).bind(info.status, info.appointed_name, role).run();
  await audit(env, 'ROLE_APPOINTMENT', { role_id: role, details: { status: info.status, name: info.appointed_name } });
  return { ok: true, ...info, connector_verified: false };
}

async function createMockJob(env, raw) {
  const job = validateMockJob(raw);
  const existing = await env.DB.prepare(
    'SELECT id,pipeline_id,status FROM factory_jobs WHERE idempotency_key=?'
  ).bind(job.idempotency_key).first();
  if (existing) return { created: false, deduplicated: true, job_id: existing.id, pipeline_id: existing.pipeline_id, status: existing.status };
  const id = crypto.randomUUID();
  const input = JSON.stringify({ title: job.title, brief: job.brief, canon_gate: true, verified_assets_only: true });
  const added = await env.DB.prepare(
    "INSERT OR IGNORE INTO factory_jobs (id,pipeline_id,universe,mode,status,source_system,input_json," +
    "paid_enabled,publish_enabled,budget_currency,budget_max,estimated_cost,actual_cost," +
    "asset_approval,paid_batch_approval,publish_approval,idempotency_key) " +
    "VALUES (?,?,?,'mock','awaiting_review',?, ?,0,0,'TWD',0,0,0,'pending','pending','pending',?)"
  ).bind(id, job.pipeline_id, job.pipeline_id === 'A' ? '貓掌江湖／喵台灣' : null,
    SOURCE, input, job.idempotency_key).run();
  if (!added.meta?.changes) {
    const found = await env.DB.prepare('SELECT id,pipeline_id,status FROM factory_jobs WHERE idempotency_key=?')
      .bind(job.idempotency_key).first();
    if (!found) throw new Error('任務去重衝突');
    return { created: false, deduplicated: true, job_id: found.id, pipeline_id: found.pipeline_id, status: found.status };
  }
  await env.DB.prepare(
    'INSERT INTO factory_events(id,job_id,event_type,payload_json) VALUES (?,?,?,?)'
  ).bind(crypto.randomUUID(), id, 'HQ_MOCK_REVIEW',
    JSON.stringify({ mock: true, provider_calls: 0, publish_calls: 0, actual_cost_twd: 0 })).run();
  await audit(env, 'MOCK_JOB_CREATED', { job_id: id, details: { pipeline: job.pipeline_id, title: job.title } });
  return { created: true, deduplicated: false, job_id: id, pipeline_id: job.pipeline_id, status: 'awaiting_review', provider_calls: 0, publish_calls: 0, actual_cost_twd: 0 };
}

const EXAMPLES = Object.freeze({
  A: { title: 'A 線｜貓掌與喵台灣題材 Mock', brief: '驗證非政治原創內容、角色正史與審核閘門；不生成、不發文。' },
  B: { title: 'B 線｜成年時尚視覺 Mock', brief: '驗證合法、非露骨成人時尚視覺素材流程；不生成。' },
  C: { title: 'C 線｜舞魅喵 MV Mock', brief: '驗證 MV 分鏡、音畫同步與角色武器鎖定；不生成音樂或影片。' },
  D: { title: 'D 線｜長篇漫劇 Mock', brief: '驗證分章、連戲與素材銜接任務流程；不呼叫模型。' }
});

async function mockAll(env, input) {
  const batch = String(input?.batch_key || '');
  if (!/^[a-zA-Z0-9:_-]{8,100}$/.test(batch)) throw new Error('請提供有效的測試批次鍵');
  const results = [];
  for (const pipeline_id of HQ_PIPELINES) {
    const item = EXAMPLES[pipeline_id];
    results.push(await createMockJob(env, {
      pipeline_id, ...item, mode:'mock', idempotency_key:batch + ':' + pipeline_id
    }));
  }
  return { ok: true, count: results.length, jobs: results, provider_calls: 0, publish_calls: 0, actual_cost_twd: 0 };
}

export async function handleHqRequest(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: allowedOrigin(req) ? 204 : 403, headers: headers(req,false) });
  }
  try {
    if (req.method === 'GET' && path === '/api/factory/hq/public')
      return answer(req, await publicOverview(env));
    if (!(await authorized(req, env))) return answer(req, { error: '需要總部 ADMIN_KEY 授權' }, 401);
    if (req.method === 'GET' && path === '/api/factory/hq/state')
      return answer(req, await privateState(env));
    if (req.method === 'POST' && path === '/api/factory/hq/jobs')
      return answer(req, await createMockJob(env, await readJson(req)), 201);
    if (req.method === 'POST' && path === '/api/factory/hq/mock-run')
      return answer(req, await mockAll(env, await readJson(req)), 201);
    const rolePath = path.match(/^\/api\/factory\/hq\/roles\/(HQ|A|B|C|D|W)$/);
    if (req.method === 'PATCH' && rolePath)
      return answer(req, await hireRole(env, rolePath[1], await readJson(req)));
    return answer(req, { error: '找不到總部操作' }, 404);
  } catch (e) {
    const message = String(e?.message || e || '未知錯誤').slice(0, 500);
    const invalid = /只能|必須|不允許|未知|請|超過|格式|去重|閘門|授權|限制|過大/.test(message);
    return answer(req, { error: message }, invalid ? 400 : 500);
  }
}
