import test from 'node:test';
import assert from 'node:assert/strict';
import {
 assessViralTopic,verifyProfileInputs,writeNeutralProfile
} from '../src/p5-viral-policy.js';
import {factoryP5CrossPlatformIngest} from '../src/factory-p5.js';

const profile=()=>({
 category:'politics_profile',content_kind:'biography',
 source_url:'https://news.example.com/public-profile',
 title:'立法委員人物生涯介紹',
 source_summary:'近期公眾關注這位立法委員的公開經歷',
 person:{name:'某某公眾人物',role:'立法委員'},
 political:true,neutral_facts_verified:true,
 verification_urls:['https://www.ly.gov.tw/Pages/Detail.aspx','https://news.example.com/bio'],
 verified_at:new Date().toISOString(),
 age_hours:1,metrics_verified:true,metrics:{views:210000}
});
test('neutral political/public-figure biographies may pass with independent sources',()=>{
 const raw=profile();
 const verified=verifyProfileInputs(raw);
 assert.equal(verified.ok,true);
 const result=assessViralTopic(raw,{riskLevel:'medium',heat:85,relevance:10});
 assert.equal(result.eligible,true);
 assert.equal(result.action_type,'original_post');
 assert.equal(result.reason,'verified_neutral_profile');
 assert.equal(result.priority,'high');
 assert.match(result.text,/公開職務／身分：立法委員/);
 assert.ok(result.text.includes(raw.source_url));
 assert.ok(!result.text.includes('投給'));
});
test('political persuasion, unsupported claims and scandal trends stay in review',()=>{
 const base=profile();
 for(const text of ['請大家票投某某公眾人物','某某立委遭爆料有不明財產','政治詐騙指控']) {
  const r=assessViralTopic({...base,title:text},{riskLevel:'low',heat:100,relevance:100});
  assert.equal(r.eligible,false,text);
 }
 const unverified=assessViralTopic({...base,neutral_facts_verified:false},{riskLevel:'medium',heat:100});
 assert.equal(unverified.eligible,false);
 assert.match(unverified.reason,/requires_review/);
 const debate=assessViralTopic({...base,category:'politics_profile',content_kind:'debate'},{riskLevel:'medium',heat:100});
 assert.equal(debate.eligible,false);
});
test('verified profile sources must be distinct domains and recent',()=>{
 const x=profile();
 assert.equal(verifyProfileInputs({...x,verification_urls:['https://news.example.com/a','https://news.example.com/b']}).ok,false);
 assert.equal(verifyProfileInputs({...x,verified_at:new Date(Date.now()-36*3600000).toISOString()}).ok,false);
 assert.equal(verifyProfileInputs({...x,person:{name:'',role:''}}).ok,false);
});
test('all low-risk trends may win by verified traffic without relevance keyword gate',()=>{
 const r=assessViralTopic({category:'sports',title:'賽事',age_hours:1,metrics_verified:true,metrics:{views:140000}},
   {riskLevel:'low',heat:70,relevance:5});
 assert.equal(r.eligible,true);
 assert.equal(r.priority,'high');
 assert.equal(assessViralTopic({category:'sports',age_hours:1,metrics:{views:140000}},
   {riskLevel:'low',heat:70,relevance:5}).eligible,false);
 assert.equal(assessViralTopic({category:'sports',age_hours:48,metrics_verified:true,metrics:{views:140000}},
   {riskLevel:'low',heat:70,relevance:70}).eligible,false);
});
test('native quote/repost uses real Threads post ID, never downloads media',()=>{
 const base={category:'entertainment',age_hours:1,source_url:'https://www.threads.com/@creator/post/X',
  original_post_public:true,target_thread_id:'123456789012345',metrics_verified:true,metrics:{views:300000}};
 let r=assessViralTopic({...base,distribution_strategy:'native_repost'},
  {riskLevel:'low',heat:75,relevance:75});
 assert.equal(r.eligible,true);assert.equal(r.action_type,'repost');
 r=assessViralTopic({...base,distribution_strategy:'native_quote'},
  {riskLevel:'low',heat:75,relevance:75});
 assert.equal(r.action_type,'quote');
 r=assessViralTopic({...base,source_url:'https://evil.com/post/X',distribution_strategy:'native_repost'},
  {riskLevel:'low',heat:75,relevance:75});
 assert.equal(r.eligible,false);
 r=assessViralTopic({...base,contains_unlicensed_media:true},
  {riskLevel:'low',heat:75,relevance:75});
 assert.equal(r.eligible,false);
 const political=assessViralTopic({...profile(),source_url:base.source_url,target_thread_id:base.target_thread_id,
  original_post_public:true,distribution_strategy:'native_repost'}, {riskLevel:'medium',heat:99,relevance:99});
 assert.equal(political.eligible,false);
});
function fakeEnv(){
 const items=new Map(),actions=new Map();
 return {
  items,actions,
  env:{FACTORY_P5_ENABLED:'true',FACTORY_P5_AUTO_SEND:'true',FACTORY_P5_ALLOW_EXTERNAL_PUBLISH:'true',
   DB:{prepare(sql){let params=[];return {
     bind(...args){params=args;return this},
     async first(){
       if(sql.includes('FROM social_cross_platform_items WHERE source_url='))return items.get(params[0])||null;
       throw Error('Unexpected first '+sql);
     },
     async run(){
       if(sql.includes('INSERT INTO social_cross_platform_items')){
         const [id,platform,url]=params;
         const old=items.get(url);
         items.set(url,{id:old?.id||id,action_id:old?.action_id||null,status:old?.status||'scored',source_platform:platform});
         return {meta:{changes:1}};
       }
       if(sql.includes('INSERT OR IGNORE INTO social_actions')){
         if(actions.has(params[0]))return {meta:{changes:0}};
         actions.set(params[0],{id:params[0],action_type:params[4],target_thread_id:params[5],text:params[6]});
         return {meta:{changes:1}};
       }
       if(sql.includes('UPDATE social_cross_platform_items SET status=')){
         const item=items.get(params[2]);item.status='queued';item.action_id=params[0];return {meta:{changes:1}};
       }
       throw Error('Unexpected run '+sql);
     }
   }}}}
 };
}
test('repeated high-reach ingest never queues a duplicate action',async()=>{
 const x=fakeEnv();
 const item={source_url:'https://news.example.com/popular-01',
  source_platform:'web',category:'entertainment',title:'台灣新戲劇爆紅',
  source_summary:'台灣最新熱門話題',age_hours:1,metrics:{views:550000},
  metrics_verified:true};
 const req=()=>new Request('https://example.com/ingest',
  {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(item)});
 const first=await factoryP5CrossPlatformIngest(req(),x.env);
 assert.equal(first.created[0].queued,true);
 assert.equal(x.actions.size,1);
 const second=await factoryP5CrossPlatformIngest(req(),x.env);
 assert.equal(second.created[0].queued,false);
 assert.equal(second.created[0].decision,'already_queued_or_published');
 assert.equal(x.actions.size,1);
});
test('political factual profile ingest produces neutral original post not political slogans',async()=>{
 const x=fakeEnv(),raw=profile();
 const req=new Request('https://example.com/ingest',
  {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(raw)});
 const out=await factoryP5CrossPlatformIngest(req,x.env);
 assert.equal(out.created[0].queued,true,JSON.stringify(out));
 assert.equal(out.created[0].risk_level,'low');
 const a=[...x.actions.values()][0];
 assert.equal(a.action_type,'original_post');
 assert.match(a.text,/喵台灣人物焦點/);
 assert.equal(writeNeutralProfile(raw,verifyProfileInputs(raw)),a.text);
});
