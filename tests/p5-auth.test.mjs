import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { p5AuthPage, p5AuthStatus, issueScopedScoutKey, isScopedScoutKey } from '../src/p5-auth.js';
import controller from '../src/ai-worker.js';

function db(initial={}) {
  const saved=new Map(Object.entries(initial));
  return {
    saved,
    env:{
      DB:{
        prepare(sql){
          let args=[];return {
            bind(...a){args=a;return this},
            async first(){
              if(sql.includes('FROM settings WHERE key='))return saved.has(args[0])?{value:saved.get(args[0])}:null;
              throw Error('Unexpected first: '+sql);
            },
            async run(){
              if(sql.includes('INSERT INTO settings')){saved.set(args[0],args[1]);return {meta:{changes:1}}}
              throw Error('Unexpected run: '+sql);
            }
          };
        }
      },
      ADMIN_KEY:'example-admin',
      THREADS_APP_ID:'12345',
      THREADS_APP_SECRET:'example-app-secret'
    }
  };
}
function issueReq(origin='https://threads-scheduler.gogototo24.workers.dev'){
  return new Request('https://threads-scheduler.gogototo24.workers.dev/api/factory/p5/auth/issue',{
    method:'POST',headers:{origin,'content-type':'application/json'},
    body:JSON.stringify({confirm:'ISSUE_SCOPED_P5_KEY'})
  });
}
test('admin page never embeds secrets and browser controller parses',async()=>{
  const result=p5AuthPage();assert.equal(result.status,200);
  const html=await result.text();
  assert.ok(html.includes('24H 海巡授權中心'));
  assert.ok(html.includes('連接／重新授權 Threads'));
  assert.equal(html.includes('example-admin'),false);
  assert.match(result.headers.get('cache-control'),/no-store/);
  assert.equal(result.headers.get('x-frame-options'),'DENY');
  const script=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(()=>new Script(script[1]));
});
test('no stored OAuth is clearly not connected',async()=>{
  const {env}=db();const status=await p5AuthStatus(env);
  assert.equal(status.threads_oauth_live_valid,false);
  assert.equal(status.threads_token_stored,false);
  assert.equal(status.scoped_key_usable,false);
  assert.equal(status.scout_external_client_connected,null);
});
test('OAuth readback checks actual /me and does not publish',async()=>{
  const {env}=db({'threads_access_token':'fake_token','threads_username':'catpaw'});
  const prev=globalThis.fetch;let called=0;
  globalThis.fetch=async uri=>{
    assert.match(String(uri),/graph\.threads\.net\/v1\.0\/me/);
    assert.equal(String(uri).includes('threads_publish'),false);
    called++;
    return {ok:true,status:200,json:async()=>({id:'123',username:'real-catpaw'})};
  };
  try{
    const s=await p5AuthStatus(env);
    assert.equal(s.threads_oauth_live_valid,true);
    assert.equal(s.threads_account,'real-catpaw');
    assert.equal(called,1);
  }finally{globalThis.fetch=prev;}
});
test('create high-entropy scoped key, store digest only and verify with constant-time comparison',async()=>{
  const {env,saved}=db();
  const out=await issueScopedScoutKey(issueReq(),env);
  assert.match(out.one_time_key,/^p5s_[a-f0-9]{64}$/);
  assert.equal(saved.has('p5_scoped_key_sha256'),true);
  assert.equal(saved.get('p5_scoped_key_sha256').includes(out.one_time_key),false);
  const req=new Request('https://example.com/p5',{headers:{'x-p5-scout-key':out.one_time_key}});
  assert.equal(await isScopedScoutKey(req,env),true);
  assert.equal(await isScopedScoutKey(new Request('https://example.com/p5',{
    headers:{'x-p5-scout-key':out.one_time_key.replace(/.$/,'0')}
  }),env),out.one_time_key.endsWith('0'));
  assert.equal((await p5AuthStatus(env)).scoped_key_usable,true);
});
test('origin check blocks cross-site credential rotation',async()=>{
 const {env}=db();
 await assert.rejects(()=>issueScopedScoutKey(issueReq('https://evil.example'),env),/來源驗證失敗/);
});
test('rotating key invalidates previous issued credential',async()=>{
 const {env}=db();
 const previous=await issueScopedScoutKey(issueReq(),env);
 const replacement=await issueScopedScoutKey(issueReq(),env);
 assert.notEqual(previous.one_time_key,replacement.one_time_key);
 assert.equal(await isScopedScoutKey(new Request('https://example.com',{headers:{'x-p5-scout-key':previous.one_time_key}}),env),false);
 assert.equal(await isScopedScoutKey(new Request('https://example.com',{headers:{'x-p5-scout-key':replacement.one_time_key}}),env),true);
});
test('protected admin route rejects unauthorized requests and never issues credentials',async()=>{
  const {env}=db();
  const plain=await controller.fetch(new Request('https://threads-scheduler.gogototo24.workers.dev/api/factory/p5/auth/status'),env,{});
  assert.equal(plain.status,401);
  const page=await controller.fetch(new Request('https://threads-scheduler.gogototo24.workers.dev/p5/authorize'),env,{});
  assert.equal(page.status,302);
  const login=await controller.fetch(new Request('https://threads-scheduler.gogototo24.workers.dev/p5/authorize',{
    headers:{'x-admin-key':'example-admin'}
  }),env,{});
  assert.equal(login.status,200);
});
