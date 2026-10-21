// CatPaw P5: Cloudflare Cron -> official RSS -> safety filter -> Threads Fastlane.
// Only the official Ministry of Culture source is enabled in this version.
import { fastLaneSubmit } from './p5-fastlane.js';
import { processPublicActions } from './factory-p5.js';

export const FEED_URL='https://www.moc.gov.tw/OpenData.aspx?SN=C4E4E3A8E687AD91';
const HOST='www.moc.gov.tw';
const MAX_AGE=90*60000;
const ALLOW=/布袋戲|歌仔戲|戲曲|劇場|藝術|展覽|特展|表演|戲劇|音樂|演出|文化|書展|繪本|閱讀|動畫|動漫|博物館|文創|燈會|工藝|影展|電影|美術|市集/;
const DENY=/總統|立法院|政治|選舉|罷免|公投|政黨|候選人|立委|議員|市長|兩岸|外交|國防|戰爭|抗議|詐騙|火災|事故|傷亡|死亡|病逝|辭世|性侵|性騷|侵害|爭議|衝突|訴訟|司法|法規|政策|補助|預算|採購|裁罰|疫|緊急|天災|地震|治安|停電|勞資爭議/;

function text(raw) {
 return String(raw||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
  .replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
  .replace(/&quot;/gi,'"').replace(/&apos;/gi,"'")
  .replace(/&#(x[0-9a-f]+|\d+);/gi,(_m,n)=>{
    const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);
    return v>=32&&v<=0x10ffff?String.fromCodePoint(v):'';
  }).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}
function field(item,tags) {
 for(const tag of tags){
  const found=item.match(new RegExp('<(?:[\\w-]+:)?'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?'+tag+'\\s*>','i'));
  if(found)return text(found[1]);
 }
 return '';
}
export function parseOfficialFeed(xml,now=Date.now()){
 if(typeof xml!=='string'||xml.length<40||xml.length>2097152||!/<(?:rss|rdf:RDF|feed)\b/i.test(xml))throw Error('官方 RSS 內容無效');
 const entries=xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi)||[];
 const result=[],seen=new Set();
 for(const item of entries.slice(0,40)){
  const title=field(item,['title']);
  const link=field(item,['link','guid']);
  const posted=field(item,['pubDate','published','updated','date']);
  const time=Date.parse(posted);
  let url;try{url=new URL(link)}catch{continue}
  if(url.protocol!=='https:'||url.hostname.toLowerCase()!==HOST||url.username||url.password)continue;
  url.hash='';
  if(!Number.isFinite(time)||time>now+180000||now-time>MAX_AGE)continue;
  if(title.length<7||title.length>220||!ALLOW.test(title)||DENY.test(title))continue;
  if(seen.has(url.href))continue;seen.add(url.href);
  result.push({title,source_url:url.href,published_at:new Date(time).toISOString()});
 }
 return result.sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at));
}
export function buildOriginalPost(item){
 const title=item.title.slice(0,125);
 return '🎭 喵台灣文化速報！\n文化部最新公告提到：「'+title+'」\n你最想了解這項藝文消息的哪個部分？😸\n官方來源：'+item.source_url+'\n#喵台灣 #台灣文化';
}
const slotFor=(now)=>new Date(Math.floor(now/600000)*600000).toISOString();
async function writeRun(env,slot,x){
 await env.DB.prepare(
  'UPDATE p5_official_scout_runs SET status=?,scanned=?,eligible=?,submitted=?,published=?,skipped=?,last_action_id=?,last_permalink=?,detail=?,finished_at=? WHERE slot=?'
 ).bind(x.status,x.scanned,x.eligible,x.submitted,x.published,x.skipped,x.action||null,x.permalink||null,
   String(x.detail||'').slice(0,450),new Date().toISOString(),slot).run();
}
export async function runOfficialScout(env,now=Date.now(),fetcher=fetch){
 if(String(env.FACTORY_P5_OFFICIAL_SCOUT_ENABLED||'').toLowerCase()!=='true')return {enabled:false};
 if(String(env.FACTORY_P5_AUTO_SEND||'').toLowerCase()!=='true'||
    String(env.FACTORY_P5_ALLOW_EXTERNAL_PUBLISH||'').toLowerCase()!=='true')return {enabled:false,reason:'publication_gate_closed'};
 const slot=slotFor(now);
 const claim=await env.DB.prepare(
   "INSERT OR IGNORE INTO p5_official_scout_runs(slot,source_url,status,started_at) VALUES (?,?,'started',?)"
 ).bind(slot,FEED_URL,new Date(now).toISOString()).run();
 if(!claim.meta?.changes)return {enabled:true,skipped_duplicate_run:true,slot};
 const out={status:'no_fresh',scanned:0,eligible:0,submitted:0,published:0,skipped:0,action:null,permalink:null,detail:''};
 try{
  const response=await fetcher(FEED_URL,{method:'GET',redirect:'follow',
   headers:{accept:'application/rss+xml,application/xml,text/xml'},signal:AbortSignal.timeout(9000)});
  if(!response.ok||(response.url&&new URL(response.url).hostname!==HOST))throw Error('RSS 網路錯誤 HTTP '+response.status);
  const xml=await response.text();
  out.scanned=(xml.match(/<(?:item|entry)(?:\s[^>]*)?>/gi)||[]).length;
  const entries=parseOfficialFeed(xml,now);
  out.eligible=entries.length;
  // One official article maximum per 10-minute run, never a bulk posting.
  for(const item of entries.slice(0,10)){
   if(await env.DB.prepare('SELECT id FROM social_cross_platform_items WHERE source_url=? LIMIT 1')
        .bind(item.source_url).first()){out.skipped++;continue;}
   let article;
   try{article=await fetcher(item.source_url,{method:'GET',redirect:'follow',signal:AbortSignal.timeout(8000)})}
   catch{out.skipped++;out.detail='官方文章無法重新驗證';continue}
   if(!article.ok||new URL(article.url||item.source_url).hostname!==HOST){
     out.skipped++;out.detail='官方文章來源驗證失敗';continue;
   }
   const body={title:item.title,source_url:item.source_url,category:'culture',
     verified_at:new Date(now).toISOString(),verification_method:'official',
     verification_urls:[item.source_url],text:buildOriginalPost(item),
     contains_unlicensed_media:false,political:false,high_risk:false,review_required:false};
   const req=new Request('https://threads-scheduler.gogototo24.workers.dev/api/factory/p5/fastlane',{
     method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
   const result=await fastLaneSubmit(req,env,actionId=>processPublicActions(env,{
     auto_send:true,hourly_action_limit:Math.max(1,Math.min(10,Number(env.FACTORY_P5_HOURLY_ACTION_LIMIT||10)))
   },actionId));
   out.submitted+=result.deduplicated?0:1;
   out.published+=result.published?1:0;
   out.action=result.action_id||null;out.permalink=result.permalink||null;
   out.status=result.published?'published':(result.status||'queued');
   out.detail=result.error||('文化部官方來源：'+item.source_url);
   break; // Hard limit: one processed original per scan.
  }
  if(out.status==='no_fresh'&&out.skipped>0)out.status='already_seen_or_unavailable';
 }catch(e){out.status='error';out.detail=String(e?.message||e).slice(0,400);}
 await writeRun(env,slot,out);
 return {enabled:true,slot,...out};
}
export async function officialScoutStatus(env){
 const latest=await env.DB.prepare('SELECT * FROM p5_official_scout_runs ORDER BY started_at DESC LIMIT 1').first();
 const statuses=await env.DB.prepare('SELECT status,COUNT(*) AS n FROM p5_official_scout_runs WHERE started_at>=? GROUP BY status')
  .bind(new Date(Date.now()-86400000).toISOString()).all();
 return {
  enabled:String(env.FACTORY_P5_OFFICIAL_SCOUT_ENABLED||'').toLowerCase()==='true',
  source:FEED_URL,frequency:'10-minute cadence on Cloudflare Cron',
  coverage:'官方文化部 RSS；不代表完整台灣社群全網',
  latest:latest||null,last_24h:statuses.results||[],metricool_new_posts:false
 };
}

export async function publicOfficialScoutStatus(env) {
 const latest=await env.DB.prepare(
  'SELECT started_at,finished_at,status,scanned,eligible,submitted,published,skipped,last_permalink FROM p5_official_scout_runs ORDER BY started_at DESC LIMIT 1'
 ).first();
 return {
   system:'CatPaw P5 Official Scout',
   enabled:String(env.FACTORY_P5_OFFICIAL_SCOUT_ENABLED||'').toLowerCase()==='true',
   source_name:'文化部官方文化新聞',
   coverage:'文化部官方 RSS，非全網海巡',
   check_interval_minutes:10,
   latest:latest?{
     started_at:latest.started_at,finished_at:latest.finished_at,
     status:latest.status,scanned:latest.scanned,eligible:latest.eligible,
     submitted:latest.submitted,published:latest.published,skipped:latest.skipped,
     permalink:latest.last_permalink||null
   }:null,
   diagnostic_code:latest?.status==='error' ? (
     /^RSS 網路錯誤 HTTP (\d{3})/.test(String(latest.detail||''))
       ? 'RSS_HTTP_'+String(latest.detail).match(/^RSS 網路錯誤 HTTP (\d{3})/)[1]
       : /RSS 內容無效/.test(String(latest.detail||'')) ? 'RSS_FORMAT_INVALID'
       : /fetch|network|Failed/i.test(String(latest.detail||'')) ? 'RSS_NETWORK_FAILURE'
       : 'OFFICIAL_SOURCE_ERROR'
   ) : null,
   read_error_excerpt: latest?.status==='error' && Number(latest.scanned)===0
      ? String(latest.detail||'').replace(/(?:access_token|api[_-]?key|token|secret)=[^&\s]+/gi,'[REDACTED]').slice(0,150)
      : null,
   no_new_metricool_posts:true,
   no_private_credentials:true
 };
}
