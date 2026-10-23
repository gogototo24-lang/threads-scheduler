// CatPaw Native Autopilot v1: independent, opt-in, scheduled VIDEO series.
// AITuber-inspired public workflow, independently implemented with existing P3,
// CatPaw CANON and Threads VIDEO queue. No n8n, TinyFish or Metricool dependency.
import { factoryP3Create } from './factory-p3.js';

const TZ = 'Asia/Taipei';
const ID_RE = /^[a-z][a-z0-9_-]{3,39}$/;
const HTTPS = /^https:\/\//i;
const MAX_SERIES = 10;
const MAX_CAPTION = 500;

function enabled(v) { return v === true || String(v).toLowerCase() === 'true'; }
function stamp() { return new Date().toISOString(); }
function localDateAndTime(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone:TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit',
    minute:'2-digit', hourCycle:'h23'
  }).formatToParts(date).map(x => [x.type,x.value]));
  return {day:p.year+'-'+p.month+'-'+p.day,hhmm:p.hour+':'+p.minute};
}
function cleanText(v,max=200) { return String(v||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,max); }
function safeUrl(raw) {
  if(!raw) return '';
  let u;
  try {u=new URL(String(raw));}catch{throw Error('素材 URL 無效');}
  if(u.protocol!=='https:'||u.username||u.password||!u.hostname||u.hostname.endsWith('.local'))
    throw Error('素材必須是有效 HTTPS 來源');
  return u.href;
}
function parseSettings(raw) {
  try{return JSON.parse(raw||'{}');}catch{return {};}
}
function validate(input) {
  const id = String(input.series_id||'').trim();
  if(!ID_RE.test(id))throw Error('series_id 必須為 4–40 字英文小寫／數字／底線／連字號');
  const title = cleanText(input.title,100);
  if(title.length<3)throw Error('系列名稱過短');
  const pipeline=String(input.pipeline||'A').toUpperCase();
  if(!['A','C'].includes(pipeline))throw Error('目前僅支援 A：參考圖影片、C：既有影片自動剪輯；D 線連戲尾幀未接通');
  const scheduleTime=String(input.schedule_time||'05:50');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime))throw Error('schedule_time 須為 HH:MM（台灣時間）');
  const topicBank=(Array.isArray(input.topic_bank)?input.topic_bank:String(input.topic_bank||'').split('\n'))
    .map(x=>cleanText(x,400)).filter(Boolean).slice(0,20);
  if(topicBank.length<1)throw Error('至少需提供一個原創劇情／題材');
  const firstFrame=safeUrl(input.first_frame_url||'');
  const clipUrls=(Array.isArray(input.clip_urls)?input.clip_urls:String(input.clip_urls||'').split('\n'))
    .map(v=>String(v).trim()).filter(Boolean).slice(0,25).map(safeUrl);
  if(pipeline==='A'&&!firstFrame)throw Error('A 線必須指定已核准 Master 首幀 HTTPS URL');
  if(pipeline==='C'&&!clipUrls.length)throw Error('C 線必須指定已授權既有影片 URLs');
  const monthlyBudget=Number(input.monthly_budget_twd ?? input.month_budget_twd ?? 0);
  const estimate=Number(input.estimated_run_twd ?? 0);
  if(!Number.isFinite(monthlyBudget)||monthlyBudget<0||monthlyBudget>30000||
     !Number.isFinite(estimate)||estimate<0||estimate>100)
    throw Error('月預算必須 0–30000 元，單筆預估不得超過 100 元');
  if(pipeline==='A' && (!estimate||monthlyBudget<estimate))
    throw Error('A 線須明確設定預估單筆成本與足額月預算');
  const duration=Number(input.duration_seconds|| (pipeline==='A'?5:30));
  if(pipeline==='A'&&duration!==5)throw Error('A 線 RunningHub 工作流目前固定 5 秒');
  if(pipeline==='C'&&![30,60,275].includes(duration))throw Error('C 線現有剪輯器支援 30、60、275 秒');
  const s={
    series_id:id,title,pipeline,schedule_time:scheduleTime,time_zone:TZ,
    universe:String(input.universe|| (pipeline==='C'?'貓掌江湖 MV':'貓掌江湖')).slice(0,80),
    topic_bank:topicBank,first_frame_url:firstFrame,clip_urls:clipUrls,
    music_url:safeUrl(input.music_url||''),duration_seconds:duration,
    month_budget_twd:monthlyBudget,estimated_run_twd:estimate,
    style:cleanText(input.style||'9:16, cinematic Taiwanese glove-puppet aesthetics, beautiful female anthropomorphic cats, faithful costume and weapon, no gore',450),
    voice:cleanText(input.voice||'台灣繁體中文女聲；有台語錄音時優先使用核准聲線',140),
    caption_prefix:cleanText(input.caption_prefix||'',160),
    character_id:cleanText(input.character_id||'',50),
    master_approved:enabled(input.master_approved),
    media_rights_approved:enabled(input.media_rights_approved),
    cost_approved:enabled(input.cost_approved),
    autopublish:enabled(input.autopublish),
    enabled:enabled(input.enabled)
  };
  // Consent flags must be bound to the exact master/clip bank, not inferred.
  if(s.enabled && !s.master_approved)throw Error('先確認 Master 圖／人物正史已核准才能啟用');
  if(s.enabled && !s.media_rights_approved)throw Error('先確認參考圖／片段可合法使用才能啟用');
  if(s.enabled && pipeline==='A' && !s.cost_approved)
    throw Error('A 線生成會消耗 RunningHub 成本，啟用時須明確核准預算');
  return s;
}
export function buildAutopilotPlan(settings,day) {
  const s = validate(settings),index=Math.abs(day.split('-').reduce((a,x)=>a*31+Number(x),0))%s.topic_bank.length;
  const topic=s.topic_bank[index];
  const key='auto-'+s.series_id+'-'+day.replace(/-/g,'');
  const prompt=[
    s.style,
    'Story hook in first 2 seconds; consistent character face, outfit and exactly the canonical weapon.',
    'All feline warriors are female. Never turn feline paws into human hands. No duplicate limbs or weapons.',
    'One dramatic action with visible impact, clear beginning and end, stable clean final frame.',
    topic
  ].join(' ');
  const body={
    pipeline_id:s.pipeline,
    universe:s.universe,
    title:(s.title+'｜'+topic).slice(0,160),
    idempotency_key:key
  };
  if(s.pipeline==='A')Object.assign(body,{
    prompt,first_frame_url:s.first_frame_url,
    duration_seconds:5,budget_max_twd:s.estimated_run_twd
  });
  else Object.assign(body,{
    clip_urls:s.clip_urls,music_url:s.music_url,ending_text:topic,
    duration_seconds:s.duration_seconds,transition:'cut',smart_cut:true
  });
  return {body,topic,estimated_cost_twd:s.estimated_run_twd};
}
export async function autopilotUpsert(request,env) {
  const raw=await request.json(),s=validate(raw);
  const exists=await env.DB.prepare('SELECT id FROM autopilot_series WHERE id=?').bind(s.series_id).first();
  if(!exists){
    const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM autopilot_series').first();
    if(Number(count?.n||0)>=MAX_SERIES)throw Error('最多 10 個系列，避免無限制批量生成');
  }
  await env.DB.prepare(
    "INSERT INTO autopilot_series (id,title,enabled,settings_json,updated_at) VALUES (?,?,?,?,?) "+
    "ON CONFLICT(id) DO UPDATE SET title=excluded.title,enabled=excluded.enabled,settings_json=excluded.settings_json,updated_at=excluded.updated_at"
  ).bind(s.series_id,s.title,s.enabled?1:0,JSON.stringify(s),stamp()).run();
  return {ok:true,series_id:s.series_id,enabled:s.enabled,scheduled:s.schedule_time+' '+TZ,
    video_generation_ready:s.enabled,auto_publish_requested:s.autopublish,
    note:'系列僅按排程觸發；付費及發布仍由全域安全閘門獨立控制'};
}
export async function autopilotList(env) {
  const series=(await env.DB.prepare('SELECT id,title,enabled,settings_json,updated_at FROM autopilot_series ORDER BY updated_at DESC LIMIT 20').all()).results||[];
  const runs=(await env.DB.prepare(
    'SELECT id,series_id,local_day,status,p3_job_id,post_id,video_url,estimated_cost_twd,error,created_at,updated_at FROM autopilot_runs ORDER BY created_at DESC LIMIT 40'
  ).all()).results||[];
  return {series:series.map(s=>({...s,settings:parseSettings(s.settings_json),settings_json:undefined})),runs,
    global:{autopilot_enabled:enabled(env.CATPAW_AUTOPILOT_ENABLED),
      paid_enabled:enabled(env.CATPAW_AUTOPILOT_PAID_ENABLED),
      publish_enabled:enabled(env.FACTORY_PUBLISH_ENABLED)}};
}
export async function autopilotPublic(env) {
  const total=await env.DB.prepare('SELECT COUNT(*) AS n FROM autopilot_series WHERE enabled=1').first();
  const latest=await env.DB.prepare(
    'SELECT local_day,status,updated_at FROM autopilot_runs ORDER BY created_at DESC LIMIT 1'
  ).first();
  return {system:'CatPaw Native Autopilot v1',
    enabled:enabled(env.CATPAW_AUTOPILOT_ENABLED),
    series_enabled:Number(total?.n||0),latest:latest||null,
    timezone:TZ,
    supported:['A: RunningHub reference-image short video','C: editor montage from licensed existing clips'],
    excludes:['unauthorized media copy','unapproved Master','YouTube auto upload (not wired)','AI narration/TTS (not wired)'],
    publisher:'Threads official API via existing Worker VIDEO scheduler',
    note:'Video series requires approved real source assets, provider readiness and explicit cost/publish gates'};
}
async function updateRun(env,id,status,fields={}) {
  await env.DB.prepare(
    'UPDATE autopilot_runs SET status=?,p3_job_id=COALESCE(?,p3_job_id),post_id=COALESCE(?,post_id),'+
    'video_url=COALESCE(?,video_url),error=?,updated_at=? WHERE id=?'
  ).bind(status,fields.p3_job_id||null,fields.post_id||null,fields.video_url||null,
    fields.error||null,stamp(),id).run();
}
export async function runAutopilot(env,date=new Date()) {
  if(!enabled(env.CATPAW_AUTOPILOT_ENABLED))return {enabled:false};
  const current=localDateAndTime(date);
  const series=(await env.DB.prepare(
    'SELECT id,settings_json FROM autopilot_series WHERE enabled=1 ORDER BY id LIMIT ?'
  ).bind(MAX_SERIES).all()).results||[];
  let started=0,blocked=0,skipped=0;
  for(const row of series){
    const s=parseSettings(row.settings_json);
    const [h,m]=s.schedule_time.split(':').map(Number),[ch,cm]=current.hhmm.split(':').map(Number);
    const delta=(ch*60+cm)-(h*60+m);
    if(delta<0||delta>19){skipped++;continue;}
    const runId=s.series_id+':'+current.day;
    if(s.pipeline==='A'&&!enabled(env.CATPAW_AUTOPILOT_PAID_ENABLED)){blocked++;continue;}
    if(s.pipeline==='A'){
      const month=current.day.slice(0,7);
      const monthSpent=await env.DB.prepare(
        "SELECT COALESCE(SUM(estimated_cost_twd),0) AS n FROM autopilot_runs WHERE series_id=? AND local_day LIKE ?"
      ).bind(s.series_id,month+'%').first();
      if(Number(monthSpent?.n||0)+Number(s.estimated_run_twd)>Number(s.month_budget_twd)){blocked++;continue;}
      const active=await env.DB.prepare(
        "SELECT id FROM factory_jobs WHERE mode='live' AND pipeline_id='A' AND status IN ('queued','retrying','generating') LIMIT 1"
      ).first();
      if(active){skipped++;continue;}
    }
    const plan=buildAutopilotPlan(s,current.day);
    const claim=await env.DB.prepare(
      "INSERT OR IGNORE INTO autopilot_runs (id,series_id,local_day,status,topic,estimated_cost_twd,created_at,updated_at) "+
      "VALUES (?,?,?,'claimed',?,?,?,?)"
    ).bind(runId,s.series_id,current.day,plan.topic,plan.estimated_cost_twd,stamp(),stamp()).run();
    if(!claim.meta?.changes){skipped++;continue;}
    try {
      const request=new Request('https://internal.invalid/api/factory/p3/jobs',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(plan.body)
      });
      const result=await factoryP3Create(request,env);
      if(!result?.job_id)throw Error('P3 產線沒有回傳真實工作 ID');
      await updateRun(env,runId,'generating',{p3_job_id:result.job_id});
      started++;
    }catch(e){
      await updateRun(env,runId,'failed',{error:String(e?.message||e).slice(0,450)});
    }
  }
  return {enabled:true,started,blocked,skipped};
}
// Rehost completed MP4 in the existing R2 MEDIA bucket before Threads sees it.
// Provider signed download URLs may expire before Meta finishes transcoding.
export async function archiveAutopilotVideo(env,runId,remoteUrl,fetcher=fetch) {
  if(!env.MEDIA||!HTTPS.test(String(env.PUBLIC_BASE_URL||'')))
    throw Error('R2 MEDIA 或公開 Worker URL 尚未配置');
  const u=safeUrl(remoteUrl);
  const response=await fetcher(u,{method:'GET',redirect:'follow',
    signal:AbortSignal.timeout(45000)});
  if(!response.ok||!response.body)throw Error('成片來源無法公開下載 HTTP '+response.status);
  const target=new URL(response.url||u);
  if(target.protocol!=='https:')throw Error('成片下載被重新導向非 HTTPS');
  const max=25*1024*1024;
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>max)throw Error('成片超過 Threads VIDEO 25MB 上限');
  const chunks=[];let size=0;
  const reader=response.body.getReader();
  try{
    while(true){
      const next=await reader.read();
      if(next.done)break;
      size+=next.value.length;
      if(size>max)throw Error('成片實際超過 25MB 上限');
      chunks.push(next.value);
    }
  }catch(e){await reader.cancel().catch(()=>{});throw e;}
  if(size<12)throw Error('成片內容過短，不是有效 MP4');
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(new TextDecoder().decode(bytes.slice(4,8))!=='ftyp')
    throw Error('成片不是 ftyp MP4 容器');
  const key='autopilot/'+runId.replace(/[^a-z0-9_:-]/gi,'_')+'.mp4';
  await env.MEDIA.put(key,bytes,{
    httpMetadata:{contentType:'video/mp4',cacheControl:'public, max-age=86400'}
  });
  return {media_key:key,media_url:String(env.PUBLIC_BASE_URL).replace(/\/$/,'')+
    '/media/'+encodeURIComponent(key),bytes:size};
}

export async function reconcileAutopilot(env) {
  if(!enabled(env.CATPAW_AUTOPILOT_ENABLED))return {enabled:false};
  const rows=(await env.DB.prepare(
    "SELECT r.*,s.settings_json FROM autopilot_runs r JOIN autopilot_series s ON s.id=r.series_id "+
    "WHERE r.status IN ('generating','ready','queued_to_publish','processing') ORDER BY r.created_at LIMIT 25"
  ).all()).results||[];
  let ready=0,queued=0,published=0,needsAttention=0;
  for(const r of rows){
    const s=parseSettings(r.settings_json);
    if(r.post_id){
      const post=await env.DB.prepare('SELECT status,thread_id,permalink,error FROM posts WHERE id=?')
        .bind(r.post_id).first();
      if(!post){await updateRun(env,r.id,'needs_attention',{error:'排程貼文遺失，禁止重複送件'});needsAttention++;continue;}
      if(post.status==='published'&&post.thread_id){await updateRun(env,r.id,'published');published++;}
      else if(['failed','publish_unknown'].includes(post.status)){
        await updateRun(env,r.id,'needs_attention',{error:String(post.error||post.status).slice(0,350)});needsAttention++;
      }else if(['processing','publishing','preparing'].includes(post.status))await updateRun(env,r.id,'processing');
      continue;
    }
    if(r.status==='generating'){
      const job=await env.DB.prepare('SELECT id,status,asset_approval FROM factory_jobs WHERE id=?')
        .bind(r.p3_job_id).first();
      if(!job){await updateRun(env,r.id,'needs_attention',{error:'找不到對應的 P3 生成任務'});needsAttention++;continue;}
      if(job.status==='failed'){await updateRun(env,r.id,'failed',{error:'P3 工作失敗，保留已扣費記錄，不自動重送'});continue;}
      if(job.status!=='ready')continue;
      if(job.asset_approval!=='auto_qa_passed'){
        await updateRun(env,r.id,'needs_attention',{error:'P3 素材未通過技術驗收'});needsAttention++;continue;
      }
      const asset=await env.DB.prepare(
        "SELECT url,mock FROM factory_assets WHERE job_id=? AND kind='video' ORDER BY created_at DESC LIMIT 1"
      ).bind(job.id).first();
      if(!asset?.url||Number(asset.mock)!==0||!HTTPS.test(asset.url)){
        await updateRun(env,r.id,'needs_attention',{error:'沒有通過 QA 的真實影片 HTTPS URL'});needsAttention++;continue;
      }
      await updateRun(env,r.id,'ready',{video_url:asset.url});ready++;
    }
    if(!s.autopublish||!enabled(env.FACTORY_PUBLISH_ENABLED))continue;
    // A series cannot turn on publishing just because its job was generated.
    if(!s.master_approved||!s.media_rights_approved)continue;
    const claim=await env.DB.prepare(
      "UPDATE autopilot_runs SET status='publishing_claimed',updated_at=? WHERE id=? AND status='ready'"
    ).bind(stamp(),r.id).run();
    if(!claim.meta?.changes)continue;
    try{
      const postId=crypto.randomUUID();
      const caption=(s.title+'｜'+r.topic+'\n'+(s.caption_prefix||'')+
        '\n'+(s.universe.includes('貓掌')?'#貓掌江湖 #布袋戲':'#喵台灣 #台灣')).slice(0,MAX_CAPTION);
      const media=await archiveAutopilotVideo(env,r.id,r.video_url);
      await env.DB.prepare(
        "INSERT INTO posts(id,text,media_type,media_key,media_url,scheduled_at,status) VALUES (?,?,'VIDEO',?,?,?,'scheduled')"
      ).bind(postId,caption,media.media_key,media.media_url,stamp()).run();
      await updateRun(env,r.id,'queued_to_publish',{post_id:postId});
      queued++;
    }catch(e){
      await updateRun(env,r.id,'needs_attention',{error:'影片入列失敗，禁止自動重試：'+String(e).slice(0,300)});
      needsAttention++;
    }
  }
  return {enabled:true,ready,queued,published,needs_attention:needsAttention};
}
export function autopilotUi() {
  return new Response(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CatPaw Autopilot 系列總控</title>
<style>body{font-family:system-ui,sans-serif;background:#101722;color:#f1f4f9;margin:0;padding:18px;max-width:850px;margin:auto}
h1{font-size:23px}.muted{color:#9fb2c8}label{display:block;margin:12px 0 4px}
input,textarea,select{box-sizing:border-box;width:100%;padding:11px;background:#1e2937;border:1px solid #596879;border-radius:8px;color:white}
textarea{min-height:90px}button{padding:13px 18px;border:0;border-radius:8px;background:#f7be4c;color:#241900;font-weight:700;margin:16px 0}
fieldset{border:1px solid #465263;border-radius:10px;padding:14px;margin:14px 0}
.ck{display:inline-flex;gap:8px;align-items:center;margin:9px 10px 0 0}.ck input{width:auto}
article{border:1px solid #34465b;padding:13px;margin:12px 0;border-radius:9px;white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>🐾 CatPaw Autopilot｜影片自動產線</h1>
<p class="muted">台灣時間每天自動挑選原創題材，交由既有 P3 RunningHub／Editor 產生影片。成本、角色核准與發文另有獨立閘門；此頁需登入管理員。</p>
<form id="f"><label>系列 ID</label><input name="series_id" value="catpaw-martial-a" required>
<label>系列名稱</label><input name="title" value="貓掌江湖・每日極武" required>
<label>產線／影片類型</label><select name="pipeline"><option value="A">A：RunningHub H3 單鏡 5 秒</option><option value="C">C：用既有合法影片剪輯 30 秒</option></select>
<label>每天時間（台北）</label><input name="schedule_time" type="time" value="05:50">
<label>主題／劇本素材庫（一行一則，自動輪替）</label><textarea name="topic_bank">雲海之上的最後一道金色掌印，山門重啟
無聲雨夜，黑色折扇定住時間
十三面戰鼓停止，第十四鼓的影子出現</textarea>
<label>角色 ID</label><input name="character_id" placeholder="MZ_003">
<label>已核准首幀 URL（A 線必填）</label><input name="first_frame_url" placeholder="https://...">
<label>已授權影片 URL（一行一個，C 線必填）</label><textarea name="clip_urls" placeholder="https://...mp4"></textarea>
<label>音樂 URL（C 線選填）</label><input name="music_url" placeholder="https://...">
<label>片長</label><select name="duration_seconds"><option value="5">5 秒（A）</option><option value="30">30 秒（C）</option><option value="60">60 秒（C）</option><option value="275">275 秒（C）</option></select>
<label>單筆預估成本 NT$（A 線須 >0）</label><input name="estimated_run_twd" type="number" min="0" max="100" value="15">
<label>月預算上限 NT$</label><input name="monthly_budget_twd" type="number" min="0" max="30000" value="450">
<fieldset><legend>分開開關，避免未核准就付費／發布</legend>
<label class="ck"><input type="checkbox" name="master_approved">Master／角色正史已核准</label>
<label class="ck"><input type="checkbox" name="media_rights_approved">素材具有使用權</label>
<label class="ck"><input type="checkbox" name="cost_approved">核准本系列費用</label>
<label class="ck"><input type="checkbox" name="autopublish">影片技術 QA 後自動發 Threads（仍受全域開關控制）</label>
<label class="ck"><input type="checkbox" name="enabled">啟用此系列排程</label></fieldset>
<button>儲存系列</button></form><p id="msg"></p><h2>已設定系列／最近任務</h2><div id="list"></div>
<script>
const f=document.getElementById('f'),msg=document.getElementById('msg'),out=document.getElementById('list');
async function refresh(){const r=await fetch('/api/factory/autopilot/series');if(!r.ok){out.textContent='需先登入首頁管理員';return}
const d=await r.json();out.replaceChildren();
const h=document.createElement('article');h.textContent='全域：'+JSON.stringify(d.global);out.append(h);
for(const s of d.series){const a=document.createElement('article');a.textContent=(s.enabled?'✅ ':'⏸ ')+s.title+' ('+s.id+')｜'+s.settings.schedule_time;out.append(a)}
for(const x of d.runs.slice(0,15)){const a=document.createElement('article');a.textContent=x.local_day+'｜'+x.series_id+'｜'+x.status+'｜'+(x.error||x.video_url||'');out.append(a)}
}
f.addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(f),d={};for(const [k,v] of fd)d[k]=v;
for(const k of ['enabled','master_approved','media_rights_approved','cost_approved','autopublish'])d[k]=fd.has(k);
d.clip_urls=String(d.clip_urls||'').split('\\n').filter(Boolean);
d.topic_bank=String(d.topic_bank||'').split('\\n').filter(Boolean);
const r=await fetch('/api/factory/autopilot/series',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)});
msg.textContent=JSON.stringify(await r.json());refresh();});refresh();
</script></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'" }});
}
