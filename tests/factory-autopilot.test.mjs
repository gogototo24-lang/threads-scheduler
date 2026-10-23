import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAutopilotPlan, archiveAutopilotVideo, autopilotUi, autopilotPublic,
  autopilotUpsert, runAutopilot, reconcileAutopilot
} from '../src/factory-autopilot.js';

const base = {
 series_id:'catpaw-martial',title:'貓掌江湖每日武戲',pipeline:'A',
 schedule_time:'05:50',universe:'貓掌江湖',topic_bank:[
   '黑扇展開，雨滴凝固在月色中','烈焰巨龍衝破十方夜幕'
 ],
 first_frame_url:'https://cdn.example.com/approved-master.png',
 character_id:'MZ_001',master_approved:true,media_rights_approved:true,
 cost_approved:true,estimated_run_twd:15,monthly_budget_twd:450,
 enabled:true,autopublish:false
};
test('canonical A-series plan preserves approved Master URL and generates deterministic idempotency key',()=>{
 const out=buildAutopilotPlan(base,'2026-10-24');
 assert.equal(out.body.pipeline_id,'A');
 assert.equal(out.body.first_frame_url,base.first_frame_url);
 assert.equal(out.body.duration_seconds,5);
 assert.equal(out.estimated_cost_twd,15);
 assert.equal(out.body.idempotency_key,'auto-catpaw-martial-20261024');
 assert.match(out.body.prompt,/female/);
});
test('disable unsafe paid master configs',()=>{
 for(const update of [
  {first_frame_url:''},{master_approved:false},{media_rights_approved:false},
  {cost_approved:false},{monthly_budget_twd:10},
  {duration_seconds:15},{pipeline:'D'},{first_frame_url:'http://unsecure.example.com/x.png'}
 ]) assert.throws(()=>buildAutopilotPlan({...base,...update},'2026-10-24'));
});
test('C montage uses pre-approved video clips with no paid RunningHub job',()=>{
 const c={...base,pipeline:'C',first_frame_url:'',clip_urls:[
  'https://cdn.example.com/cut1.mp4','https://cdn.example.com/cut2.mp4'
 ],duration_seconds:30,estimated_run_twd:0,monthly_budget_twd:0,cost_approved:false};
 const output=buildAutopilotPlan(c,'2026-10-24');
 assert.equal(output.body.pipeline_id,'C');
 assert.equal(output.body.clip_urls.length,2);
 assert.equal(output.body.duration_seconds,30);
 assert.equal(output.body.budget_max_twd,undefined);
});
test('autopilot has independent environment gate and cannot run simply because P5 is active',async()=>{
 const x=await runAutopilot({CATPAW_AUTOPILOT_ENABLED:'false'});
 assert.deepEqual(x,{enabled:false});
 const y=await reconcileAutopilot({CATPAW_AUTOPILOT_ENABLED:'false'});
 assert.deepEqual(y,{enabled:false});
});
test('cron with no enabled series creates zero jobs',async()=>{
 const db={prepare(q){return {bind(){return this},async all(){return {results:[]}}}}};
 const x=await runAutopilot({CATPAW_AUTOPILOT_ENABLED:'true',DB:db},new Date('2026-10-24T21:50:00Z'));
 assert.equal(x.started,0);
});
test('A video never starts when paid provider gate is off',async()=>{
 let paidCalls=0;
 const db={prepare(q){return {
  bind(){return this},async all(){return {results:[{id:base.series_id,settings_json:JSON.stringify(base)}]}},
  async first(){paidCalls++;throw Error('should not touch paid jobs when locked')},
  async run(){paidCalls++;throw Error('should not create jobs')}
 }}};
 const t=new Date('2026-10-23T21:50:00Z'); // 05:50 Asia/Taipei on Oct 24
 const out=await runAutopilot({CATPAW_AUTOPILOT_ENABLED:'true',CATPAW_AUTOPILOT_PAID_ENABLED:'false',DB:db},t);
 assert.equal(out.started,0);assert.equal(out.blocked,1);assert.equal(paidCalls,0);
});
test('upsert requires all three approvals before enabling series',async()=>{
 let writes=0;
 const db={prepare(q){return {
  bind(){return this},async first(){return q.includes('COUNT(')?{n:0}:null},
  async run(){writes++;return {meta:{changes:1}}}
 }}};
 await assert.rejects(()=>autopilotUpsert(new Request('https://internal.invalid',{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({...base,master_approved:false})
 }),{DB:db}));
 assert.equal(writes,0);
 const good=await autopilotUpsert(new Request('https://internal.invalid',{
   method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(base)
 }),{DB:db});
 assert.equal(good.ok,true);assert.equal(writes,1);
});
test('public view exposes no paid secret and mobile admin page has safety toggles',async()=>{
 const env={CATPAW_AUTOPILOT_ENABLED:'true',RUNNINGHUB_API_KEY:'SENSITIVE_SECRET',DB:{
  prepare(q){return {async first(){return q.includes('COUNT')?{n:0}:null}}}
 }};
 const status=await autopilotPublic(env);
 assert.equal(status.enabled,true);
 assert.equal(JSON.stringify(status).includes('SENSITIVE_SECRET'),false);
 const html=await autopilotUi().text();
 assert.match(html,/Master/);
 assert.match(html,/autopublish/);
 assert.match(html,/monthly_budget_twd/);
});

test('video export uses real non-expiring R2 URL, not provider signed URL',async()=>{
  let uploaded=null;
  const env={PUBLIC_BASE_URL:'https://threads-scheduler.gogototo24.workers.dev',
    MEDIA:{async put(key,bytes,meta){uploaded={key,bytes,meta};}}};
  const data=new Uint8Array(20);data.set([0,0,0,20,102,116,121,112,105,115,111,109]);
  const media=await archiveAutopilotVideo(env,'demo:2026-10-24',
    'https://cdn.example.com/generated.mp4',
    async()=>new Response(data,{status:200,headers:{'content-type':'video/mp4'}}));
  assert.equal(media.bytes,20);
  assert.match(media.media_url,/^https:\/\/threads-scheduler\.gogototo24\.workers\.dev\/media\//);
  assert.equal(uploaded.meta.httpMetadata.contentType,'video/mp4');
});
test('video exporter blocks corrupt MP4 and unbounded large video',async()=>{
  const env={PUBLIC_BASE_URL:'https://threads-scheduler.gogototo24.workers.dev',MEDIA:{async put(){throw Error('should not write');}}};
  await assert.rejects(()=>archiveAutopilotVideo(env,'test:2026-10-24','https://cdn.example.com/x.mp4',
    async()=>new Response(new Uint8Array(24),{status:200})),/ftyp/);
  await assert.rejects(()=>archiveAutopilotVideo(env,'test:2026-10-24','https://cdn.example.com/x.mp4',
    async()=>new Response(new Uint8Array(24),{status:200,headers:{'content-length':'26214401'}})),/25MB/);
});
