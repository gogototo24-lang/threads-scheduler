import test from 'node:test';
import assert from 'node:assert/strict';
import {FEED_URL,parseOfficialFeed,buildOriginalPost,runOfficialScout} from '../src/p5-official-autoscout.js';

const NOW=Date.parse('2026-10-21T06:00:00Z');
function rss(articles){
 return '<?xml version="1.0"?><rss version="2.0"><channel>'+
 articles.map(x=>'<item><title><![CDATA['+x.title+']]></title><link>'+
 x.url.replaceAll('&','&amp;')+'</link><pubDate>'+new Date(x.time).toUTCString()+
 '</pubDate></item>').join('')+'</channel></rss>';
}
const good={title:'戲曲中心公布布袋戲新展覽',url:'https://www.moc.gov.tw/News_Content.aspx?n=105&s=123',time:NOW-60000};
test('official feed allows fresh performing arts, rejects politics, old news and unofficial links',()=>{
 const list=rss([
  good,
  {...good,title:'選舉政治文化補助活動',url:'https://www.moc.gov.tw/News_Content.aspx?s=124'},
  {...good,title:'全新展覽資訊',url:'https://www.evil.example.com/News_Content.aspx?s=124'},
  {...good,title:'博物館開幕消息',url:'https://www.moc.gov.tw/News_Content.aspx?s=125',time:NOW-7200000}
 ]);
 const out=parseOfficialFeed(list,NOW);
 assert.equal(out.length,1);
 assert.equal(out[0].title,good.title);
 assert.equal(out[0].source_url,good.url);
});
test('official source text is attributed, original and short',()=>{
 const text=buildOriginalPost(good);
 assert.match(text,/文化部/);
 assert.ok(text.includes(good.url));
 assert.ok(text.includes('喵台灣'));
 assert.ok(Array.from(text).length<=500);
});
test('never scans when official flag or publishing gate disabled',async()=>{
 assert.equal((await runOfficialScout({},NOW)).enabled,false);
 const result=await runOfficialScout({FACTORY_P5_OFFICIAL_SCOUT_ENABLED:'true'},NOW);
 assert.equal(result.reason,'publication_gate_closed');
});

function fakeDb(){
 const runs=new Map(),actions=new Map(),evidence=new Map();
 return {
  runs,actions,evidence,DB:{
   prepare(sql){let args=[];return {
    bind(...a){args=a;return this},
    async first(){
     if(sql.includes('social_cross_platform_items WHERE source_url'))return evidence.has(args[0])?{id:evidence.get(args[0])}:null;
     if(sql.includes('FROM settings WHERE'))return {value:'mock-OAuth-token'};
     if(sql.includes('COUNT(*) AS n'))return {n:[...actions.values()].filter(a=>a.status==='sent').length};
     if(sql.includes('FROM social_actions WHERE id='))return actions.get(args[0])||null;
     throw Error('UNHANDLED SELECT '+sql);
    },
    async all(){
     if(sql.includes('FROM social_actions WHERE id=')){
      const a=actions.get(args[0]);return {results:a?.status==='queued'?[{...a}]:[]};
     }
     throw Error('UNHANDLED SELECT ALL '+sql);
    },
    async run(){
     if(sql.includes('INSERT OR IGNORE INTO p5_official_scout_runs')){
      if(runs.has(args[0]))return {meta:{changes:0}};
      runs.set(args[0],{slot:args[0],status:'started'});return {meta:{changes:1}};
     }
     if(sql.includes('UPDATE p5_official_scout_runs SET')){
      Object.assign(runs.get(args[10]),{status:args[0],scanned:args[1],eligible:args[2],submitted:args[3],published:args[4],action:args[6],permalink:args[7]});
      return {meta:{changes:1}};
     }
     if(sql.includes('INSERT OR IGNORE INTO social_actions')){
      if(actions.has(args[0]))return {meta:{changes:0}};
      actions.set(args[0],{id:args[0],status:'queued',text:args[1],action_type:'original_post',risk_level:'low',created_at:new Date(NOW).toISOString(),scheduled_at:new Date(NOW).toISOString()});
      return {meta:{changes:1}};
     }
     if(sql.includes('INSERT OR IGNORE INTO social_cross_platform_items')){
      evidence.set(args[1],args[0]);return {meta:{changes:1}};
     }
     if(sql.includes("UPDATE social_actions SET status='sending'")){
      const a=actions.get(args[1]);if(a.status!=='queued')return {meta:{changes:0}};
      a.status='sending';return {meta:{changes:1}};
     }
     if(sql.includes("UPDATE social_actions SET status='sent'")){
      const a=actions.get(args[4]);a.status='sent';a.external_thread_id=args[0];a.permalink=args[1];a.sent_at=args[2];return {meta:{changes:1}};
     }
     throw Error('UNHANDLED UPDATE '+sql);
    }
   }}
  }
 };
}

test('native cron uses official source, creates one Threads publication, and never repeats the same item',async()=>{
 const store=fakeDb();
 const env={DB:store.DB,FACTORY_P5_OFFICIAL_SCOUT_ENABLED:'true',FACTORY_P5_AUTO_SEND:'true',
   FACTORY_P5_ALLOW_EXTERNAL_PUBLISH:'true',FACTORY_P5_HOURLY_ACTION_LIMIT:'10'};
 let newsFetches=0,publishCalls=0;
 const officialFetch=async url=>{
   newsFetches++;
   if(url===FEED_URL)return {ok:true,status:200,url:FEED_URL,text:async()=>rss([good])};
   if(url===good.url)return {ok:true,status:200,url:good.url};
   throw Error('Unexpected official URL '+url);
 };
 const prev=globalThis.fetch;
 globalThis.fetch=async url=>{
  const x=String(url);
  if(x.includes('/me/threads_publish?')){publishCalls++;return {ok:true,status:200,json:async()=>({id:'thread-123'})}}
  if(x.includes('/me/threads?'))return {ok:true,status:200,json:async()=>({id:'container-123'})};
  if(x.includes('fields=permalink'))return {ok:true,status:200,json:async()=>({permalink:'https://www.threads.com/@catpaw/post/123'})};
  throw Error('Forbidden external request '+x);
 };
 try{
  const first=await runOfficialScout(env,NOW,officialFetch);
  assert.equal(first.status,'published');
  assert.equal(first.published,1);
  assert.equal(first.submitted,1);
  assert.equal(first.permalink,'https://www.threads.com/@catpaw/post/123');
  assert.equal(publishCalls,1);
  assert.equal(newsFetches,2);

  const duplicate=await runOfficialScout(env,NOW,officialFetch);
  assert.equal(duplicate.skipped_duplicate_run,true);
  assert.equal(publishCalls,1);

  const later=await runOfficialScout(env,NOW+600000,officialFetch);
  assert.equal(later.published,0);
  assert.equal(publishCalls,1);
 }finally{globalThis.fetch=prev}
});
test('when RSS unavailable, scout records error and posts nothing',async()=>{
 const store=fakeDb(),env={DB:store.DB,FACTORY_P5_OFFICIAL_SCOUT_ENABLED:'true',
   FACTORY_P5_AUTO_SEND:'true',FACTORY_P5_ALLOW_EXTERNAL_PUBLISH:'true'};
 const result=await runOfficialScout(env,NOW,async()=>({ok:false,status:503,url:FEED_URL}));
 assert.equal(result.status,'error');
 assert.equal(result.published,0);
 assert.equal(store.runs.size,1);
});
