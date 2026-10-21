// CatPaw P5 production autopilot.
// Cloudflare Cron -> available official RSS -> safety + freshness check ->
// verified official article -> idempotent Threads official API publish.
// No n8n/browser/AI model/Metricool dependency. Zero paid generation.
import { fastLaneSubmit } from './p5-fastlane.js';
import { processPublicActions } from './factory-p5.js';

export const FEED_SOURCES=Object.freeze([
  {url:'https://www.taiwan.net.tw/rss.aspx?sno=0001001',host:'www.taiwan.net.tw',label:'交通部觀光署',category:'tourism'},
  {url:'https://www.tpedoit.gov.taipei/OpenData.aspx?SN=FFD154F901BB9155',host:'www.tpedoit.gov.taipei',label:'臺北市政府觀光傳播局',category:'culture'}
]);
export const FEED_URL=FEED_SOURCES[0].url;
const OFFICIAL_HOSTS=new Set(FEED_SOURCES.map(x=>x.host));
// A government press release may show a date but not a precise release time.
// Twelve hours allows genuine same-day news but prevents days-old replays.
const MAX_AGE=12*60*60000;
const ALLOW=/布袋戲|歌仔戲|戲曲|劇場|藝術|藝文|展覽|特展|表演|戲劇|音樂|演出|文化|書展|繪本|閱讀|動畫|動漫|博物館|文創|燈會|工藝|影展|電影|美術|市集|夜市|觀光|旅遊|景點|花季|樂園|節慶|祭典|煙火|美食|音樂祭|活動|限定|市集日|親子|遊行|城市導覽|節日/;
const DENY=/總統|總統府|立法院|行政院|行政院長|市長|縣長|議員|立委|政治|選舉|罷免|公投|政黨|候選人|民調|兩岸|外交|國防|戰爭|抗議|遊行抗議|詐騙|火災|事故|傷亡|死亡|病逝|辭世|性侵|性騷|侵害|爭議|衝突|訴訟|司法|法規|政策|補助|預算|採購|裁罰|疫|緊急|天災|地震|治安|停電|勞資爭議|招標|徵才|捐款|募款|金流|個資|個人資料|股價|投資|股市|軍事|演習|宣導|核定|法案|修法/;

function decode(raw) {
 return String(raw||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
  .replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
  .replace(/&quot;/gi,'"').replace(/&apos;/gi,"'")
  .replace(/&#(x[0-9a-f]+|\d+);/gi,(_m,n)=>{
    const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);
    return v>=32&&v<=0x10ffff?String.fromCodePoint(v):'';
  }).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}
function field(item,tags) {
 for(const tag of tags) {
  const found=item.match(new RegExp('<(?:[\\w-]+:)?'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?'+tag+'\\s*>','i'));
  if(found)return decode(found[1]);
 }
 return '';
}
export function parseOfficialFeed(xml,now=Date.now()) {
 if(typeof xml!=='string'||xml.length<40||xml.length>2097152||!/<(?:rss|rdf:RDF|feed)\b/i.test(xml))throw Error('官方 RSS 內容無效');
 const entries=xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi)||[];
 const result=[],seen=new Set();
 for(const item of entries.slice(0,55)) {
  const title=field(item,['title']);
  const link=field(item,['link','guid']);
  const posted=field(item,['pubDate','published','updated','date']);
  const timestamp=Date.parse(posted);
  let url;
  try { url=new URL(link); } catch { continue; }
  const source=FEED_SOURCES.find(s=>s.host===url.hostname.toLowerCase());
  if(!source||url.protocol!=='https:'||url.username||url.password||!OFFICIAL_HOSTS.has(url.hostname.toLowerCase()))continue;
  url.hash='';
  if(!Number.isFinite(timestamp)||timestamp>now+180000||now-timestamp>MAX_AGE)continue;
  if(title.length<7||title.length>220||!ALLOW.test(title)||DENY.test(title))continue;
  if(seen.has(url.href))continue;seen.add(url.href);
  result.push({
    title,source_url:url.href,published_at:new Date(timestamp).toISOString(),
    source_label:source.label,category:source.category,host:source.host
  });
 }
 return result.sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at));
}
export function buildOriginalPost(item) {
 const source=item.source_label || FEED_SOURCES.find(s=>s.host===new URL(item.source_url).hostname)?.label || '官方機關';
 const title=item.title.slice(0,110);
 const tourism=item.category==='tourism'||item.source_url.includes('taiwan.net.tw');
 return tourism
   ? '🐾 喵台灣玩樂雷達！\n'+source+'最新消息：「'+title+'」\n這個地方你去過嗎？推薦哪一個必玩亮點？😸\n詳情以官方公告為準：'+item.source_url+'\n#喵台灣 #台灣旅遊'
   : '🎭 喵台灣藝文雷達！\n'+source+'發布消息：「'+title+'」\n這個活動你會想參加嗎？你最期待哪一部分？😸\n詳情以官方公告為準：'+item.source_url+'\n#喵台灣 #台灣文化';
}
const slotFor=now=>new Date(Math.floor(now/600000)*600000).toISOString();
async function writeRun(env,slot,out){
 await env.DB.prepare(
  'UPDATE p5_official_scout_runs SET status=?,scanned=?,eligible=?,submitted=?,published=?,skipped=?,last_action_id=?,last_permalink=?,detail=?,finished_at=? WHERE slot=?'
 ).bind(out.status,out.scanned,out.eligible,out.submitted,out.published,out.skipped,out.action||null,out.permalink||null,
  String(out.detail||'').slice(0,450),new Date().toISOString(),slot).run();
}
async function safeFetch(fetcher,url,ms) {
 const response=await fetcher(url,{
  method:'GET',redirect:'follow',headers:{accept:'application/rss+xml,application/xml,text/xml,text/html'},
  signal:AbortSignal.timeout(ms)
 });
 const resolved=new URL(response.url||url);
 return {response,resolved};
}
export async function runOfficialScout(env,now=Date.now(),fetcher=fetch){
 if(String(env.FACTORY_P5_OFFICIAL_SCOUT_ENABLED||'').toLowerCase()!=='true')return {enabled:false};
 if(String(env.FACTORY_P5_AUTO_SEND||'').toLowerCase()!=='true'||
    String(env.FACTORY_P5_ALLOW_EXTERNAL_PUBLISH||'').toLowerCase()!=='true')
  return {enabled:false,reason:'publication_gate_closed'};
 const slot=slotFor(now);
 const claim=await env.DB.prepare(
   "INSERT OR IGNORE INTO p5_official_scout_runs(slot,source_url,status,started_at) VALUES (?,?,'started',?)"
 ).bind(slot,'government-official-rss',new Date(now).toISOString()).run();
 if(!claim.meta?.changes)return {enabled:true,skipped_duplicate_run:true,slot};
 const out={status:'no_fresh',scanned:0,eligible:0,submitted:0,published:0,skipped:0,action:null,permalink:null,detail:''};
 const entries=[],sourceErrors=[];
 for(const src of FEED_SOURCES){
  try{
   const {response,resolved}=await safeFetch(fetcher,src.url,9000);
   if(!response.ok||resolved.hostname.toLowerCase()!==src.host)throw Error(src.label+' RSS_HTTP_'+response.status);
   const xml=await response.text();
   out.scanned+=(xml.match(/<(?:item|entry)(?:\s[^>]*)?>/gi)||[]).length;
   const parsed=parseOfficialFeed(xml,now).filter(x=>x.host===src.host);
   entries.push(...parsed);
  }catch(error){sourceErrors.push(String(error?.message||error).slice(0,100));}
 }
 out.eligible=entries.length;
 if(sourceErrors.length)out.detail='來源異常：'+sourceErrors.join('；');
 if(sourceErrors.length===FEED_SOURCES.length){
  out.status='error';await writeRun(env,slot,out);
  return {enabled:true,slot,...out};
 }
 entries.sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at));
 // At most one original post per 10-minute slot, no unlicensed media.
 for(const item of entries.slice(0,24)){
  if(await env.DB.prepare('SELECT id FROM social_cross_platform_items WHERE source_url=? LIMIT 1')
    .bind(item.source_url).first()){out.skipped++;continue;}
  try{
   const {response:article,resolved}=await safeFetch(fetcher,item.source_url,8000);
   if(!article.ok||resolved.hostname.toLowerCase()!==item.host)throw Error('文章來源不可重新核實');
  }catch{out.skipped++;continue;}
  const body={
   title:item.title,source_url:item.source_url,category:item.category,
   verified_at:new Date(now).toISOString(),verification_method:'official',
   verification_urls:[item.source_url],text:buildOriginalPost(item),
   contains_unlicensed_media:false,political:false,high_risk:false,review_required:false
  };
  if(Array.from(body.text).length>500){out.skipped++;continue;}
  try{
   const req=new Request('https://threads-scheduler.gogototo24.workers.dev/api/factory/p5/fastlane',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
   });
   const res=await fastLaneSubmit(req,env,actionId=>processPublicActions(env,{
    auto_send:true,hourly_action_limit:Math.max(1,Math.min(10,Number(env.FACTORY_P5_HOURLY_ACTION_LIMIT||10)))
   },actionId));
   out.submitted+=res.deduplicated?0:1;out.published+=res.published?1:0;
   out.action=res.action_id||null;out.permalink=res.permalink||null;
   out.status=res.published?'published':res.status||'queued';
   out.detail=res.error||('政府公告：'+item.source_url);
  }catch(e){out.status='error';out.detail='Fastlane 入列失敗：'+String(e?.message||e).slice(0,260);}
  break;
 }
 if(out.status==='no_fresh'&&out.skipped>0)out.status='already_seen_or_unavailable';
 await writeRun(env,slot,out);
 return {enabled:true,slot,...out};
}
export async function officialScoutStatus(env){
 const latest=await env.DB.prepare('SELECT * FROM p5_official_scout_runs ORDER BY started_at DESC LIMIT 1').first();
 const statuses=await env.DB.prepare('SELECT status,COUNT(*) AS n FROM p5_official_scout_runs WHERE started_at>=? GROUP BY status')
  .bind(new Date(Date.now()-86400000).toISOString()).all();
 return {
  enabled:String(env.FACTORY_P5_OFFICIAL_SCOUT_ENABLED||'').toLowerCase()==='true',
  sources:FEED_SOURCES.map(s=>({name:s.label,url:s.url})),
  frequency:'every 10 minutes via Cloudflare Cron',
  coverage:'政府官方觀光／藝文 RSS；不包括未授權的社群全網搜尋',
  latest:latest||null,last_24h:statuses.results||[],metricool_new_posts:false
 };
}
export async function publicOfficialScoutStatus(env){
 const latest=await env.DB.prepare(
  'SELECT started_at,finished_at,status,scanned,eligible,submitted,published,skipped,last_permalink,detail FROM p5_official_scout_runs ORDER BY started_at DESC LIMIT 1'
 ).first();
 return {
  system:'CatPaw P5 Official Scout',
  enabled:String(env.FACTORY_P5_OFFICIAL_SCOUT_ENABLED||'').toLowerCase()==='true',
  sources:FEED_SOURCES.map(s=>({name:s.label,url:s.url})),
  coverage:'官方政府觀光／藝文 RSS，非所有 Threads 社群熱點',
  check_interval_minutes:10,
  latest:latest?{
   started_at:latest.started_at,finished_at:latest.finished_at,
   status:latest.status,scanned:latest.scanned,eligible:latest.eligible,
   submitted:latest.submitted,published:latest.published,skipped:latest.skipped,
   permalink:latest.last_permalink||null
  }:null,
  diagnostic_code:latest?.status==='error' ? (
   /HTTP[_ ](\d{3})/.test(String(latest.detail||''))
     ? 'RSS_HTTP_'+String(latest.detail).match(/HTTP[_ ](\d{3})/)[1]
     : /RSS 內容無效/.test(String(latest.detail||''))?'RSS_FORMAT_INVALID'
     : /fetch|network|Failed/i.test(String(latest.detail||''))?'RSS_NETWORK_FAILURE':'OFFICIAL_SOURCE_ERROR'
  ):null,
  read_error_excerpt:latest?.status==='error'&&Number(latest.scanned)===0
   ? String(latest.detail||'').replace(/(?:access_token|api[_-]?key|token|secret)=[^&\s]+/gi,'[REDACTED]').slice(0,150):null,
  no_new_metricool_posts:true,no_private_credentials:true
 };
}
