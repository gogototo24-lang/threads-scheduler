import test from 'node:test';
import assert from 'node:assert/strict';
import {TREND_RSS,parseTaiwanTrends,approximateSearchLowerBound,runTaiwanTrendRadar,publicTaiwanTrendRadar} from '../src/p5-trend-radar.js';
const NOW=Date.now();
const trendFeed=(items)=>'<?xml version="1.0"?><rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss"><channel>'+
 items.map(x=>'<item><title><![CDATA['+x.keyword+']]></title><ht:approx_traffic>'+x.volume+
 '</ht:approx_traffic><pubDate>'+new Date(x.at).toUTCString()+'</pubDate></item>').join('')+
 '</channel></rss>';
test('Google Trends RSS validates freshness, sorted search counts and sensitive hints',()=>{
 const list=parseTaiwanTrends(trendFeed([
  {keyword:'台灣大賽',volume:'50K+',at:NOW-60000},
  {keyword:'某政治人物姓名',volume:'10K+',at:NOW-120000},
  {keyword:'重大車禍',volume:'100K+',at:NOW-120000},
  {keyword:'過去一週舊聞',volume:'500K+',at:NOW-7*86400000}
 ]),NOW);
 assert.equal(list.length,3);
 assert.equal(list[0].keyword,'重大車禍');
 assert.equal(list[0].moderation,'high_risk_review');
 assert.equal(list[0].traffic_lower_bound,100000);
 assert.equal(list.find(x=>x.keyword==='某政治人物姓名').moderation,'unreviewed');
 assert.equal(approximateSearchLowerBound('2.5M+'),2500000);
 assert.equal(approximateSearchLowerBound('3萬+'),30000);
 assert.equal(approximateSearchLowerBound('unknown'),0);
});
function store(){
 const runs=new Map(),trends=new Map();
 return {
  runs,trends,
  DB:{prepare(sql){let p=[];return {
   bind(...x){p=x;return this},
   async run(){
    if(sql.includes('INSERT OR IGNORE INTO p5_trend_radar_runs')){
      if(runs.has(p[0]))return {meta:{changes:0}};
      runs.set(p[0],{status:'started',started_at:p[1]});return {meta:{changes:1}};
    }
    if(sql.includes('INSERT OR IGNORE INTO p5_search_trends')){
      if(trends.has(p[0]))return {meta:{changes:0}};
      trends.set(p[0],{
       keyword:p[1],source_url:p[2],first_seen_at:p[3],last_seen_at:p[4],
       published_at:p[5],traffic_label:p[6],traffic_lower_bound:p[7],category_hint:p[8],moderation:p[9]
      });
      return {meta:{changes:1}};
    }
    if(sql.includes('UPDATE p5_search_trends SET last_seen_at=')){
      const item=trends.get(p[3]);Object.assign(item,{last_seen_at:p[0],traffic_label:p[1],traffic_lower_bound:p[2]});
      return {meta:{changes:1}};
    }
    if(sql.includes('DELETE FROM p5_search_trends'))return {meta:{changes:0}};
    if(sql.includes('UPDATE p5_trend_radar_runs SET')){
      Object.assign(runs.get(p[5]),{status:p[0],scanned:p[1],newly_detected:p[2],error:p[3],finished_at:p[4]});
      return {meta:{changes:1}};
    }
    throw Error('Unexpected run SQL: '+sql);
   },
   async first(){
    if(sql.includes('FROM p5_trend_radar_runs'))return [...runs.values()].at(-1)||null;
    throw Error('Unexpected SELECT: '+sql);
   },
   async all(){
    if(sql.includes('FROM p5_search_trends'))return {results:[...trends.values()].sort((a,b)=>b.traffic_lower_bound-a.traffic_lower_bound)};
    throw Error('Unexpected SELECT ALL: '+sql);
   }
  }}}
 };
}
test('10-minute Cron stores keywords once and never calls Threads or republish',async()=>{
 const st=store();
 const env={DB:st.DB,FACTORY_P5_ENABLED:'true',FACTORY_P5_TREND_RADAR_ENABLED:'true'};
 let requests=0;
 const fetcher=async url=>{
  requests++;assert.equal(url,TREND_RSS);
  return {ok:true,status:200,url:TREND_RSS,text:async()=>trendFeed([
   {keyword:'新電影登場',volume:'20K+',at:NOW-60000},
   {keyword:'台灣棒球',volume:'50K+',at:NOW-60000}
  ])};
 };
 const a=await runTaiwanTrendRadar(env,NOW,fetcher);
 assert.equal(a.status,'done');assert.equal(a.scanned,2);assert.equal(a.newly_detected,2);
 const b=await runTaiwanTrendRadar(env,NOW,fetcher);
 assert.equal(b.already_scanned,true);assert.equal(requests,1);
 const c=await runTaiwanTrendRadar(env,NOW+600000,fetcher);
 assert.equal(c.newly_detected,0);assert.equal(requests,2);assert.equal(st.trends.size,2);
 const publicResult=await publicTaiwanTrendRadar(env);
 assert.equal(publicResult.publishes_directly,false);
 assert.equal(publicResult.top_trends.length,2);
 assert.equal(publicResult.top_trends[0].keyword,'台灣棒球');
 assert.match(publicResult.signal_metric,/NOT Threads views/);
});
test('source failures are recorded without inventing trends or publishing anything',async()=>{
 const st=store();
 const env={DB:st.DB,FACTORY_P5_ENABLED:'true'};
 const run=await runTaiwanTrendRadar(env,NOW,async()=>({
  ok:false,status:429,url:TREND_RSS
 }));
 assert.equal(run.status,'source_error');
 assert.match(run.error,/HTTP 429/);
 assert.equal(st.trends.size,0);
});
test('explicit flag switches off radar without impacting existing official scout',async()=>{
 assert.equal((await runTaiwanTrendRadar({FACTORY_P5_ENABLED:'false'})).enabled,false);
 assert.equal((await runTaiwanTrendRadar({FACTORY_P5_ENABLED:'true',FACTORY_P5_TREND_RADAR_ENABLED:'false'})).enabled,false);
});
