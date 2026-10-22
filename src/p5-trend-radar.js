// Taiwan trending keyword radar; read-only discovery, not an auto publisher.
// Google Trends search volume is NOT Threads views and is NOT confirmation
// that any event or assertion associated with the keyword is true.
export const TREND_RSS='https://trends.google.com/trending/rss?geo=TW';
export const TREND_PAGE='https://trends.google.com/trending?geo=TW&hl=zh-TW';
const MAX_AGE_MS=48*3600000;
const SIGNAL_RISK=/(?:死亡|車禍|火災|地震|殺人|事故|性侵|性騷|涉貪|貪污|爆料|指控|詐騙|恐嚇|自殺|戰爭|軍事|裸照|私密影像)/i;

function xmlText(v) {
 return String(v||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
   .replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
   .replace(/&quot;/gi,'"').replace(/&#(\d+);/g,(_m,n)=>String.fromCodePoint(Number(n)||32))
   .replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
}
function field(text,name) {
 const re=new RegExp('<(?:[a-z]+:)?'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-z]+:)?'+name+'>','i');
 return xmlText(text.match(re)?.[1]||'');
}
export function approximateSearchLowerBound(label){
 const s=String(label||'').toUpperCase().replace(/,/g,'').replace(/\s/g,'');
 const m=s.match(/^(\d+(?:\.\d+)?)([KMB萬億])?\+?$/);
 if(!m)return 0;
 const factor={'K':1000,'M':1000000,'B':1000000000,'萬':10000,'億':100000000}[m[2]]||1;
 return Math.floor(Number(m[1])*factor);
}
export function parseTaiwanTrends(xml,now=Date.now()){
 if(typeof xml!=='string'||xml.length<50||xml.length>2*1024*1024||
    !/<rss\b/i.test(xml))throw Error('Google Trends RSS 格式錯誤');
 const items=xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)||[];
 const result=[],seen=new Set();
 for(const raw of items.slice(0,80)){
  const title=field(raw,'title');
  const date=field(raw,'pubDate'),stamp=Date.parse(date);
  if(!Number.isFinite(stamp)||stamp>now+300000||now-stamp>MAX_AGE_MS)continue;
  if(title.length<2||title.length>100||seen.has(title))continue;
  seen.add(title);
  const volume=field(raw,'approx_traffic');
  result.push({
   keyword:title, published_at:new Date(stamp).toISOString(),
   traffic_label:volume||null,traffic_lower_bound:approximateSearchLowerBound(volume),
   moderation:SIGNAL_RISK.test(title)?'high_risk_review':'unreviewed',
   category_hint:/布袋戲|霹靂|戲曲|偶戲/.test(title)?'puppetry':
     /棒球|籃球|賽事|球員/.test(title)?'sports':
     /演唱會|歌手|電影|演員|戲劇/.test(title)?'entertainment':'unsorted'
  });
 }
 return result.sort((a,b)=>b.traffic_lower_bound-a.traffic_lower_bound);
}
function slotKey(now){return new Date(Math.floor(now/600000)*600000).toISOString();}
async function shaKeyword(name) {
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('TW:'+name.trim().toLowerCase()));
 return 'gtrend-'+[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,40);
}
export async function runTaiwanTrendRadar(env,now=Date.now(),fetcher=fetch){
 if(String(env.FACTORY_P5_ENABLED||'').toLowerCase()!=='true')return {enabled:false};
 if(String(env.FACTORY_P5_TREND_RADAR_ENABLED??'true').toLowerCase()!=='true')return {enabled:false};
 const slot=slotKey(now);
 const claim=await env.DB.prepare(
  "INSERT OR IGNORE INTO p5_trend_radar_runs(slot,status,started_at) VALUES (?,'started',?)"
 ).bind(slot,new Date(now).toISOString()).run();
 if(!claim.meta?.changes)return {enabled:true,already_scanned:true,slot};
 let status='done',error=null,scanned=0,newly_detected=0;
 try {
  const res=await fetcher(TREND_RSS,{method:'GET',redirect:'follow',
   headers:{accept:'application/rss+xml,application/xml,text/xml'},signal:AbortSignal.timeout(10000)});
  const real=new URL(res.url||TREND_RSS);
  if(!res.ok||real.hostname!=='trends.google.com')throw Error('Google RSS unavailable HTTP '+res.status);
  const entries=parseTaiwanTrends(await res.text(),now);
  scanned=entries.length;
  for(const item of entries.slice(0,45)){
   const uid=await shaKeyword(item.keyword);
   const insertion=await env.DB.prepare(
    "INSERT OR IGNORE INTO p5_search_trends "+
    "(trend_id,keyword,region,source_url,first_seen_at,last_seen_at,published_at,traffic_label,traffic_lower_bound,category_hint,moderation,status) "+
    "VALUES (?,?,'TW',?,?,?,?,?,?,?,?,'discovered')"
   ).bind(uid,item.keyword,TREND_PAGE,new Date(now).toISOString(),new Date(now).toISOString(),
    item.published_at,item.traffic_label,item.traffic_lower_bound,item.category_hint,item.moderation).run();
   newly_detected+=insertion.meta?.changes?1:0;
   if(!insertion.meta?.changes){
    await env.DB.prepare(
     "UPDATE p5_search_trends SET last_seen_at=?,traffic_label=?,traffic_lower_bound=? WHERE trend_id=?"
    ).bind(new Date(now).toISOString(),item.traffic_label,item.traffic_lower_bound,uid).run();
   }
  }
  // Do not turn unverified search words into claims, shares or Threads posts.
  // Keep only the last 30 days of observability, not personal search histories.
  await env.DB.prepare("DELETE FROM p5_search_trends WHERE last_seen_at<?")
   .bind(new Date(now-30*86400000).toISOString()).run();
 }catch(e){status='source_error';error=String(e?.message||e).slice(0,220);}
 await env.DB.prepare(
  "UPDATE p5_trend_radar_runs SET status=?,scanned=?,newly_detected=?,error=?,finished_at=? WHERE slot=?"
 ).bind(status,scanned,newly_detected,error,new Date().toISOString(),slot).run();
 return {enabled:true,slot,status,scanned,newly_detected,error};
}
export async function publicTaiwanTrendRadar(env){
 const last=await env.DB.prepare(
  "SELECT status,scanned,newly_detected,error,started_at,finished_at FROM p5_trend_radar_runs ORDER BY started_at DESC LIMIT 1"
 ).first();
 const rows=(await env.DB.prepare(
  "SELECT keyword,traffic_label,traffic_lower_bound,category_hint,moderation,published_at,last_seen_at "+
  "FROM p5_search_trends WHERE last_seen_at>? ORDER BY traffic_lower_bound DESC,last_seen_at DESC LIMIT 15"
 ).bind(new Date(Date.now()-86400000).toISOString()).all()).results||[];
 return {
  system:'CatPaw P5 Taiwan Viral Discovery',source:TREND_PAGE,
  frequency_minutes:10,
  signal_metric:'Google search volume, NOT Threads views',
  publishes_directly:false,
  must_verify_before_publication:true,
  latest:last||null,top_trends:rows
 };
}
