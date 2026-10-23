// CatPaw P5: real text-only automatic Threads posting from Taiwan Google
// trending SEARCH KEYWORDS already ingested to D1 by GitHub Actions.
// No claim about the underlying news/event is made: a Google trend is not
// confirmation of any allegation, and Google search count != Threads views.
// One topic = one deterministic fastlane action, published through official API.
import {fastLaneSubmit} from './p5-fastlane.js';
import {processPublicActions} from './factory-p5.js';

const BLOCK=/選舉|罷免|投票|候選人|立委|總統|副總統|市長|縣長|議員|政黨|政府|立法院|行政院|政治|國防|國際戰爭|兩岸|川普|習近平|賴清德|柯文哲|蔣萬安|黃國昌|韓國瑜|蔡英文|高市早苗|石破茂|死亡|車禍|火災|地震|殺人|命案|事故|性侵|性騷|貪污|爆料|指控|詐騙|自殺|戰爭|軍事|裸照|私密|癌症|患病|醫療|疾病|流產|外遇|離婚|緋聞|偷情|出軌|被捕|逮捕|涉案|衝突|爭議|下架|抵制|仇恨|謠言|暴力|災情|受傷|逝世|病逝|去世|遭毆|虐待|醜聞|性別|兒少|兒童受害/i;
const NON_TOPIC=/^[\d\s\p{P}\p{S}]+$/u;
const TARGET_CATEGORIES=new Set(['entertainment','puppetry','sports','unsorted']);
const HOUR=3600000, DAY=24*HOUR;
const MIN_SEARCHES=1000;
// Limit burst posting from newly synced Google keywords. No paid media.
const MAX_DAY_POSTS=4, MIN_HOURS_APART=2;

function taiwanDayStart(now) {
 const local=new Date(now+8*HOUR).toISOString().slice(0,10)+'T00:00:00Z';
 return new Date(Date.parse(local)-8*HOUR).toISOString();
}
function slotFor(now) { return new Date(Math.floor(now/600000)*600000).toISOString(); }
function charSlice(t,n) {return Array.from(String(t||'')).slice(0,n).join('');}
export function trendSuitability(row, now=Date.now()) {
 const keyword=String(row?.keyword||'').normalize('NFKC').replace(/\s+/g,' ').trim();
 const age=now-Date.parse(String(row?.published_at||''));
 const lastSeen=now-Date.parse(String(row?.last_seen_at||''));
 if(Array.from(keyword).length<2||Array.from(keyword).length>34||NON_TOPIC.test(keyword))
   return {ok:false,reason:'invalid_keyword'};
 if(BLOCK.test(keyword)||row?.moderation!=='unreviewed')
   return {ok:false,reason:'sensitive_or_political'};
 if(!TARGET_CATEGORIES.has(String(row?.category_hint||'unsorted')))
   return {ok:false,reason:'category_not_supported'};
 const n=Number(row?.traffic_lower_bound||0);
 if(!Number.isFinite(n)||n<MIN_SEARCHES)
   return {ok:false,reason:'below_search_traffic_threshold'};
 if(!Number.isFinite(age)||age< -300000||age>DAY||
    !Number.isFinite(lastSeen)||lastSeen< -300000||lastSeen>3*HOUR)
   return {ok:false,reason:'stale_trending_signal'};
 if(row?.status!=='discovered')return {ok:false,reason:'already_processed'};
 if(String(row?.source_url)!=='https://trends.google.com/trending?geo=TW&hl=zh-TW')
   return {ok:false,reason:'untrusted_source'};
 return {ok:true,keyword};
}
export function buildTrendSubmission(row,now=Date.now()) {
 const fit=trendSuitability(row,now);
 if(!fit.ok)throw Error(fit.reason);
 const keyword=fit.keyword;
 const u=new URL('https://trends.google.com/trends/explore');
 u.searchParams.set('geo','TW');
 u.searchParams.set('q',keyword);
 const url=u.toString();
 const puppet=row.category_hint==='puppetry';
 const sports=row.category_hint==='sports';
 const hook=puppet?'🎭 貓掌江湖｜江湖熱搜':sports?'⚾ 喵台灣｜運動熱搜':'🐾 喵台灣｜台灣熱搜';
 const comment=puppet?'這個名字一上榜，月扇影喵都停下手中的黑扇。你最想聊哪段精彩故事？':
  sports?'你最近也在關注這個話題嗎？哪個瞬間最值得討論？':
  '你是因為哪段作品、影片或最新討論開始關注？留言分享你的觀察！';
 const text=hook+'「'+keyword+'」\n'+
  '這是 Google 台灣熱門搜尋關鍵字，不代表任何未確認的新聞已成真。\n'+
  comment+'\n搜尋趨勢來源：'+url+'\n'+(puppet?'#貓掌江湖 #布袋戲':'#喵台灣 #台灣熱搜');
 if(Array.from(text).length>500)throw Error('post_too_long');
 return {
  title:'台灣熱門搜尋：'+keyword,
  source_url:url,
  category:puppet?'puppetry':sports?'sports':'entertainment',
  text,
  verified_at:new Date(now).toISOString(),
  verification_method:'official',
  verification_urls:[url],
  contains_unlicensed_media:false,political:false,high_risk:false,
  review_required:false
 };
}
export async function runTrendAutoPublisher(env,now=Date.now(),publish=defaultPublish) {
 if(String(env.FACTORY_P5_TREND_AUTOPOST_ENABLED||'').toLowerCase()!=='true')
  return {enabled:false};
 if(String(env.FACTORY_P5_AUTO_SEND||'').toLowerCase()!=='true'||
    String(env.FACTORY_P5_ALLOW_EXTERNAL_PUBLISH||'').toLowerCase()!=='true')
  return {enabled:false,reason:'publish_gate_closed'};
 const slot=slotFor(now);
 const claim=await env.DB.prepare(
  "INSERT OR IGNORE INTO p5_trend_autopost_runs(slot,status,started_at) VALUES (?,'started',?)"
 ).bind(slot,new Date(now).toISOString()).run();
 if(!claim.meta?.changes)return {enabled:true,already_run:true,slot};
 const out={enabled:true,slot,status:'no_eligible',eligible:0,attempted:0,published:0,
  trend_id:null,action_id:null,permalink:null,detail:null};
 try {
  // Only actual confirmed 'published' events count. Avoid content bursts.
  const dayCount=Number((await env.DB.prepare(
   "SELECT COUNT(*) AS n FROM p5_trend_autopost_runs WHERE status='published' AND started_at>=?"
  ).bind(taiwanDayStart(now)).first())?.n||0);
  const recentCount=Number((await env.DB.prepare(
   "SELECT COUNT(*) AS n FROM p5_trend_autopost_runs WHERE status='published' AND started_at>=?"
  ).bind(new Date(now-MIN_HOURS_APART*HOUR).toISOString()).first())?.n||0);
  if(dayCount>=MAX_DAY_POSTS||recentCount>0){
   out.status='rate_limited';out.detail='daily_or_two_hour_cap';
  }else{
   // Google RSS is ingested every 10 minutes by existing GitHub Actions.
   const candidates=(await env.DB.prepare(
    "SELECT trend_id,keyword,source_url,published_at,last_seen_at,traffic_lower_bound,category_hint,moderation,status "+
    "FROM p5_search_trends WHERE status='discovered' AND last_seen_at>=? AND published_at>=? "+
    "ORDER BY traffic_lower_bound DESC,first_seen_at DESC LIMIT 50"
   ).bind(new Date(now-3*HOUR).toISOString(),new Date(now-DAY).toISOString()).all()).results||[];
   let selection=null;
   for(const row of candidates){if(trendSuitability(row,now).ok){selection=row;break;}}
   out.eligible=candidates.filter(row=>trendSuitability(row,now).ok).length;
   if(selection){
    out.trend_id=selection.trend_id;
    const body=buildTrendSubmission(selection,now);
    out.attempted=1;
    // Fastlane is atomic on the source URL and invokes the REAL Threads Graph API.
    const posted=await publish(body,env);
    out.action_id=posted.action_id||null;
    out.permalink=posted.permalink||null;
    out.published=posted.published===true&&posted.thread_id?1:0;
    out.status=out.published?'published':(posted.status||'not_confirmed');
    out.detail=out.published?'official_threads_id_confirmed':String(posted.error||posted.status||'unconfirmed').slice(0,190);
    // Do not enqueue again on subsequent runs, even when publishing is uncertain.
    await env.DB.prepare("UPDATE p5_search_trends SET status=? WHERE trend_id=?")
     .bind(out.published?'published':'verified',selection.trend_id).run();
   }
  }
 }catch(e){
  out.status='error';out.detail=String(e?.message||e).slice(0,220);
 }
 await env.DB.prepare(
  "UPDATE p5_trend_autopost_runs SET status=?,eligible=?,attempted=?,published=?,last_trend_id=?,last_action_id=?,last_permalink=?,detail=?,finished_at=? WHERE slot=?"
 ).bind(out.status,out.eligible,out.attempted,out.published,out.trend_id,
  out.action_id,out.permalink,out.detail,new Date(now).toISOString(),slot).run();
 return out;
}
async function defaultPublish(body,env){
 const request=new Request('https://threads-scheduler.gogototo24.workers.dev/api/factory/p5/fastlane',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
 });
 return fastLaneSubmit(request,env,actionId=>processPublicActions(env,{
  auto_send:true,
  hourly_action_limit:Math.max(1,Math.min(10,Number(env.FACTORY_P5_HOURLY_ACTION_LIMIT||10)))
 },actionId));
}
export async function publicTrendAutoPublisher(env){
 const last=await env.DB.prepare(
  "SELECT slot,status,eligible,attempted,published,last_permalink,finished_at FROM p5_trend_autopost_runs ORDER BY slot DESC LIMIT 1"
 ).first();
 const totals=await env.DB.prepare(
  "SELECT COALESCE(SUM(published),0) AS published,COALESCE(SUM(attempted),0) AS attempted "+
  "FROM p5_trend_autopost_runs WHERE started_at>=?"
 ).bind(new Date(Date.now()-DAY).toISOString()).first();
 return {system:'CatPaw P5 Taiwan Trend Auto Publisher',enabled:String(env.FACTORY_P5_TREND_AUTOPOST_ENABLED||'').toLowerCase()==='true',
  frequency_minutes:10,actual_publisher:'Cloudflare Worker -> Threads official API',
  safe_mode:'original text about real Google trending SEARCH KEYWORD; no unverified event assertions',
  daily_post_cap:MAX_DAY_POSTS,min_hours_apart:MIN_HOURS_APART,latest:last||null,
  last24h:{published:Number(totals?.published||0),attempted:Number(totals?.attempted||0)},
  metricool_new_posts:false};
}
