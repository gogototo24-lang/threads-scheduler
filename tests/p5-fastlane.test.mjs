import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFastLaneSubmission,fastLaneSubmit,fastLaneHealth,fastLaneActionStatus} from '../src/p5-fastlane.js';
import {processPublicActions} from '../src/factory-p5.js';

const source='https://www.example.com/events/taoyuan';
function payload(timestamp=Date.now()) {
 return {
  source_url:source,category:'entertainment',
  title:'地方藝文活動新消息',text:'今晚的地方活動消息引發討論，你會出門嗎？快看看最新官方說法。 來源：'+source,
  verified_at:new Date(timestamp).toISOString(),
  verification_method:'official',
  verification_urls:['https://www.example.gov.tw/news/latest'],
  contains_unlicensed_media:false
 };
}
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});

test('nonpolitical evidence requirements and 2-hour freshness',()=>{
  const now=Date.parse('2026-10-21T02:00:00Z');
  assert.equal(validateFastLaneSubmission(payload(now),now).category,'entertainment');
  assert.throws(()=>validateFastLaneSubmission({...payload(now),category:'politics'},now),/不符合/);
  assert.throws(()=>validateFastLaneSubmission({...payload(now),text:'選舉得票結果：'+source},now),/字數|政治/);
  assert.throws(()=>validateFastLaneSubmission({...payload(now),verified_at:new Date(now-3*60*60*1000).toISOString()},now),/重新核實/);
  assert.throws(()=>validateFastLaneSubmission({...payload(now),source_url:'http://example.com'},now),/HTTPS/);
  assert.throws(()=>validateFastLaneSubmission({...payload(now),verification_urls:[]},now),/官方/);
  assert.throws(()=>validateFastLaneSubmission({...payload(now),verification_method:'independent',verification_urls:['https://one.example.com']},now),/兩個/);
  assert.throws(()=>validateFastLaneSubmission({...payload(now),contains_unlicensed_media:true},now),/人工/);
  assert.throws(()=>validateFastLaneSubmission({...payload(now),publish:true,text:'不含來源的貼文'},now),/原創/);
});

function fastDb() {
  const actions=new Map(), cross=new Map(); let insertCalls=0;
  const env={
    DB:{prepare(sql) {let args=[];return {
      bind(...a){args=a;return this},
      async first(){
        if(sql.includes("FROM social_actions WHERE id")) return actions.get(args[0])||null;
        if(sql.includes("FROM settings WHERE key")) return {value:'token-stored'};
        throw Error('UNKNOWN FIRST '+sql);
      },
      async all(){if(sql.includes('GROUP BY status'))return {results:[]};throw Error('UNKNOWN ALL '+sql)},
      async run(){
        if(sql.includes('INSERT OR IGNORE INTO social_actions')){
          insertCalls++;
          if(actions.has(args[0]))return {meta:{changes:0}};
          actions.set(args[0],{id:args[0],text:args[1],status:'queued',external_thread_id:null,permalink:null,created_at:'test',sent_at:null,error:null});
          return {meta:{changes:1}};
        }
        if(sql.includes('INSERT OR IGNORE INTO social_cross_platform_items')){cross.set(args[1],args);return {meta:{changes:1}}}
        throw Error('UNKNOWN RUN '+sql);
      }
    }}},
    ADMIN_KEY:'admin configured',
    P5_SCOUT_KEY:'scout configured'
  };
  return {env,actions,cross,get insertCalls(){return insertCalls}};
}
test('scoped submission deduplicates same source and dispatches exactly once',async()=>{
 const db=fastDb();let calls=0;
 const post=()=>new Request('https://example.com/p5',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload())});
 const first=await fastLaneSubmit(post(),db.env,async(id)=>{calls++;return {sent:0,queued:id}});
 assert.equal(first.ok,true);assert.equal(first.deduplicated,false);
 assert.equal(first.status,'queued');assert.equal(first.thread_id,null);assert.equal(first.published,false);
 const again=await fastLaneSubmit(post(),db.env,async()=>{calls++;});
 assert.equal(again.deduplicated,true);assert.equal(calls,1);assert.equal(db.actions.size,1);
 const job=await fastLaneActionStatus(db.env,first.action_id);
 assert.equal(job.published,false);
 const health=await fastLaneHealth(db.env);
 assert.equal(health.scout_key_configured,true);
 assert.equal(health.threads_token_stored,true);
 assert.equal(health.threads_token_validated_live,false);
});

function processDb({hasToken=true}={}){
  const action={
    id:'action-1',text:'原創測試說明',action_type:'original_post',status:'queued',
    target_thread_id:null,candidate_id:null,risk_level:'low',
    scheduled_at:new Date(Date.now()-60000).toISOString()
  };
  const q=[];
  const env={DB:{
    prepare(sql){let args=[];return {
      bind(...x){args=x;return this},
      async first(){
        if(sql.includes('COUNT(*)'))return {n:0};
        if(sql.includes("FROM settings WHERE"))return hasToken?{value:'fake-token'}:null;
        throw Error('first '+sql);
      },
      async all(){if(sql.includes('FROM social_actions WHERE status='))return {results:action.status==='queued'?[{...action}]:[]};throw Error('all '+sql)},
      async run(){
        q.push(sql);
        if(sql.includes("SET status='sending'")){
          if(action.status!=='queued')return {meta:{changes:0}};
          action.status='sending';return {meta:{changes:1}};
        }
        if(sql.includes("SET status='sent'")){action.status='sent';action.external_thread_id=args[0];action.permalink=args[1];return {meta:{changes:1}};}
        if(sql.includes("SET status=?,error=?")){action.status=args[0];action.error=args[1];return {meta:{changes:1}};}
        if(sql.includes("SET status='blocked'")){action.status='blocked';return {meta:{changes:1}};}
        throw Error('run '+sql);
      }
    }}
  }};
  return {env,action,q};
}
test('process claims before publishing, reads official permalink, and prevents repeated call',async()=>{
  const x=processDb();
  const prev=globalThis.fetch;let publishCalls=0;
  globalThis.fetch=async(url,options)=>{
    const u=String(url);
    assert.equal(x.action.status,'sending');
    if(u.includes('/me/threads_publish?')){publishCalls++;return response({id:'T123'})}
    if(u.includes('/me/threads?'))return response({id:'C123'});
    if(u.includes('fields=permalink'))return response({permalink:'https://www.threads.com/@cat/post/T123'});
    throw Error('Unknown URL '+u);
  };
  try{
    const first=await processPublicActions(x.env,{auto_send:true,hourly_action_limit:5});
    assert.equal(first.sent,1);assert.equal(x.action.status,'sent');assert.equal(x.action.permalink,'https://www.threads.com/@cat/post/T123');
    const second=await processPublicActions(x.env,{auto_send:true,hourly_action_limit:5});
    assert.equal(second.sent,0);assert.equal(publishCalls,1);
  }finally{globalThis.fetch=prev}
});
test('without OAuth action is blocked_auth not falsely marked published',async()=>{
  const x=processDb({hasToken:false});
  const r=await processPublicActions(x.env,{auto_send:true,hourly_action_limit:5});
  assert.equal(r.blocked_auth,1);assert.equal(x.action.status,'blocked_auth');
});
test('after uncertain external response, publish_unknown prevents automatic duplicate',async()=>{
  const x=processDb();
  const prev=globalThis.fetch;let publishCalls=0;
  globalThis.fetch=async url=>{
    if(String(url).includes('/me/threads_publish?')){publishCalls++;throw Error('connection reset after POST')}
    return response({id:'C123'});
  };
  try{
    const r=await processPublicActions(x.env,{auto_send:true,hourly_action_limit:5});
    assert.equal(r.unknown,1);assert.equal(x.action.status,'publish_unknown');
    await processPublicActions(x.env,{auto_send:true,hourly_action_limit:5});
    assert.equal(publishCalls,1);
  }finally{globalThis.fetch=prev}
});
