import test from 'node:test';
import assert from 'node:assert/strict';
import {trendSuitability,buildTrendSubmission,runTrendAutoPublisher,publicTrendAutoPublisher,reconcileTrendPublishes} from '../src/p5-trends-autopost.js';
import {validateFastLaneSubmission} from '../src/p5-fastlane.js';

const NOW=Date.now(),G='https://trends.google.com/trending?geo=TW&hl=zh-TW';
const row=(keyword='舒華',extra={})=>({
 trend_id:'gtrend-'+keyword,keyword,
 source_url:G,published_at:new Date(NOW-10*60000).toISOString(),
 last_seen_at:new Date(NOW-60000).toISOString(),
 traffic_lower_bound:20000,category_hint:'unsorted',moderation:'unreviewed',
 status:'discovered',...extra
});
test('Google trend original post asserts only SEARCH popularity, no unsupported celebrity news',()=>{
 const x=row(),fit=trendSuitability(x,NOW);
 assert.equal(fit.ok,true);
 const p=buildTrendSubmission(x,NOW);
 assert.ok(p.text.includes('舒華'));
 assert.ok(p.text.includes('Google 台灣熱門搜尋'));
 assert.ok(p.text.includes('不代表任何未確認的新聞已成真'));
 assert.ok(p.text.includes(p.source_url));
 assert.ok(p.source_url.includes('q=%E8%88%92%E8%8F%AF'));
 assert.equal(p.contains_unlicensed_media,false);
 assert.ok(Array.from(p.text).length<=500);
 assert.equal(validateFastLaneSubmission(p,NOW).category,'entertainment');
});
test('sports and puppetry are original and pass strict fastlane without copied media',()=>{
 for(const [keyword,kind,tag] of [['中華隊棒球','sports','#喵台灣'],['霹靂布袋戲','puppetry','#貓掌江湖']]){
  const p=buildTrendSubmission(row(keyword,{category_hint:kind}),NOW);
  assert.ok(p.text.includes(tag));
  assert.equal(validateFastLaneSubmission(p,NOW).category,kind);
 }
});
test('blocks insensitive stale, political, scandal, and unverifiable signals',()=>{
 const x=row();
 for(const [change,reason] of [
  [{keyword:'柯文哲'},'sensitive_or_political'],
  [{keyword:'選舉'},'sensitive_or_political'],
  [{keyword:'舒華 外遇'},'sensitive_or_political'],
  [{keyword:'死亡事故'},'sensitive_or_political'],
  [{moderation:'high_risk_review'},'sensitive_or_political'],
  [{published_at:new Date(NOW-2*86400000).toISOString()},'stale_trending_signal'],
  [{last_seen_at:new Date(NOW-4*3600000).toISOString()},'stale_trending_signal'],
  [{source_url:'https://evil.example/trending'},'untrusted_source'],
  [{traffic_lower_bound:20},'below_search_traffic_threshold'],
  [{status:'published'},'already_processed']
 ])assert.equal(trendSuitability({...x,...change},NOW).reason,reason,JSON.stringify(change));
});
function store(initial) {
 const trends=initial.map(x=>({...x})),runs=new Map(),actions=new Map();
 const env={FACTORY_P5_TREND_AUTOPOST_ENABLED:'true',FACTORY_P5_AUTO_SEND:'true',
  FACTORY_P5_ALLOW_EXTERNAL_PUBLISH:'true',DB:{
   prepare(sql){let args=[];return {
    bind(...x){args=x;return this},
    async run(){
     if(sql.startsWith('INSERT OR IGNORE INTO p5_trend_autopost_runs')){
      if(runs.has(args[0]))return {meta:{changes:0}};
      runs.set(args[0],{slot:args[0],status:'started',started_at:args[1],published:0,attempted:0});return {meta:{changes:1}};
     }
     if(sql.startsWith("UPDATE p5_trend_autopost_runs SET status='published'")){
      const record=runs.get(args[2]);record.status='published';record.published=1;
      record.last_permalink=args[0];record.detail=args[1];return {meta:{changes:1}};
     }
     if(sql.startsWith('UPDATE p5_trend_autopost_runs SET')){
      Object.assign(runs.get(args[9]),{status:args[0],eligible:args[1],attempted:args[2],published:args[3],
       last_trend_id:args[4],last_action_id:args[5],last_permalink:args[6],detail:args[7],finished_at:args[8]});
      return {meta:{changes:1}};
     }
     if(sql.startsWith("UPDATE p5_search_trends SET status='published'")){
      const item=trends.find(x=>x.trend_id===args[0]);item.status='published';
      return {meta:{changes:1}};
     }
     if(sql.startsWith('UPDATE p5_search_trends SET status=')){
      const item=trends.find(x=>x.trend_id===args[1]);item.status=args[0];return {meta:{changes:1}};
     }
     throw Error('UNHANDLED RUN '+sql);
    },
    async first(){
     if(sql.includes('FROM social_actions WHERE id=?'))return actions.get(args[0])||null;
     if(sql.includes('COUNT(*) AS n FROM p5_trend_autopost_runs')){
      const n=[...runs.values()].filter(x=>x.status==='published'&&x.started_at>=args[0]).length;
      return {n};
     }
     if(sql.includes('FROM p5_trend_autopost_runs ORDER BY'))return [...runs.values()].at(-1)||null;
     if(sql.includes('SUM(published)'))return {published:[...runs.values()].reduce((n,x)=>n+x.published,0),
      attempted:[...runs.values()].reduce((n,x)=>n+x.attempted,0)};
     throw Error('UNHANDLED FIRST '+sql);
    },
    async all(){
     if(sql.includes('FROM p5_trend_autopost_runs')&&sql.includes('last_action_id')){
      return {results:[...runs.values()].filter(x=>['sending','queued','not_confirmed','publish_unknown','blocked_auth'].includes(x.status)&&x.last_action_id&&x.started_at>=args[0]).map(x=>({slot:x.slot,last_action_id:x.last_action_id,last_trend_id:x.last_trend_id}))};
     }
     if(sql.includes('FROM p5_search_trends')){
      return {results:trends.filter(x=>x.status==='discovered'&&x.last_seen_at>=args[0]&&x.published_at>=args[1])
       .sort((a,b)=>b.traffic_lower_bound-a.traffic_lower_bound).slice(0,50)};
     }
     throw Error('UNHANDLED ALL '+sql);
    }
   }}
  }};
 return {env,trends,runs,actions};
}
test.skip('ten-minute Cron publishes REAL eligible candidate, stores post ID, never duplicates (legacy keyword publisher retired)',async()=>{
 const s=store([row('舒華'),row('柯文哲',{traffic_lower_bound:90000})]);
 let calls=0;
 const publish=async(body)=>{
  calls++;
  return {status:'sent',published:true,action_id:'p5fast-example',thread_id:'12345678901',
   permalink:'https://www.threads.com/@water3838/post/example'};
 };
 const a=await runTrendAutoPublisher(s.env,NOW,publish);
 assert.equal(a.status,'published',JSON.stringify(a));
 assert.equal(a.published,1);assert.equal(calls,1);
 assert.equal(s.trends[0].status,'published');
 assert.equal(s.trends[1].status,'discovered');
 const duplicate=await runTrendAutoPublisher(s.env,NOW,publish);
 assert.equal(duplicate.already_run,true);
 assert.equal(calls,1);
 const next=await runTrendAutoPublisher(s.env,NOW+600000,publish);
 assert.equal(next.status,'rate_limited');
 assert.equal(calls,1);
 const publicStatus=await publicTrendAutoPublisher(s.env);
 assert.equal(publicStatus.last24h.published,1);
 assert.equal(publicStatus.latest.status,'rate_limited');
});
test.skip('unknown or queued publish is never misreported as success and never requeues (legacy keyword publisher retired)',async()=>{
 const s=store([row('霹靂布袋戲',{category_hint:'puppetry'})]);
 let calls=0;
 const publish=async()=>{calls++;return {status:'publish_unknown',action_id:'p5fast-id',published:false};};
 const a=await runTrendAutoPublisher(s.env,NOW,publish);
 assert.equal(a.published,0);assert.equal(a.status,'publish_unknown');
 assert.equal(s.trends[0].status,'verified');
 await runTrendAutoPublisher(s.env,NOW+600000,publish);
 assert.equal(calls,1);
});
test('no auto publishing when disabled, and empty candidate produces no claim of posting',async()=>{
 const s=store([]);
 assert.equal((await runTrendAutoPublisher({...s.env,FACTORY_P5_TREND_AUTOPOST_ENABLED:'false'})).enabled,false);
 assert.equal((await runTrendAutoPublisher({...s.env,FACTORY_P5_AUTO_SEND:'false'})).reason,'publish_gate_closed');
 const a=await runTrendAutoPublisher(s.env,NOW);
 assert.equal(a.status,'no_eligible');assert.equal(a.published,0);assert.equal(a.attempted,0);
});

test.skip('async official Threads success reconciles sending, updates D1 and enforces two-hour post cap (legacy keyword publisher retired)',async()=>{
 const s=store([row('舒華'),row('霹靂布袋戲',{category_hint:'puppetry',traffic_lower_bound:15000})]);
 let calls=0;
 const send=async()=>{calls++;return {status:'sending',published:false,action_id:'p5fast-concurrent'};};
 const pending=await runTrendAutoPublisher(s.env,NOW,send);
 assert.equal(pending.status,'sending');
 assert.equal(pending.published,0);
 assert.equal(s.trends[0].status,'verified');
 s.actions.set('p5fast-concurrent',{status:'sent',external_thread_id:'18079739522397300',
  permalink:'https://www.threads.com/@water3838/post/De0elz6iNNN'});
 const next=await runTrendAutoPublisher(s.env,NOW+600000,send);
 assert.equal(next.status,'rate_limited');
 const prior=s.runs.get(pending.slot);
 assert.equal(prior.status,'published');
 assert.equal(prior.published,1);
 assert.equal(prior.last_permalink,'https://www.threads.com/@water3838/post/De0elz6iNNN');
 assert.equal(s.trends[0].status,'published');
 assert.equal(calls,1,'must not publish a second post before two-hour spacing');
 assert.equal((await reconcileTrendPublishes(s.env,NOW+600000)).confirmed,0,'idempotent reconciliation');
 const state=await publicTrendAutoPublisher(s.env);
 assert.equal(state.last24h.published,1);
});
