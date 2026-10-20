import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMockJob, validateRoleUpdate, handleHqRequest, HQ_PIPELINES } from '../src/universe-hq.js';

const ORIGIN = 'https://gogototo24-lang.github.io';
function mockDb() {
  const jobs = new Map(), audit = [], events = [];
  const roles = new Map(['HQ','A','B','C','D','W'].map(id => [id, {
    role_id:id, floor_name:id, suggested_provider:'candidate',
    duty:'test', status:'candidate', appointed_name:null, connector_verified:0
  }]));
  const db = {
    jobs,audit,events,roles,
    prepare(sql) {
      return {
        args: [],
        bind(...a) { this.args=a; return this; },
        async first() {
          const a=this.args;
          if (sql.includes('COUNT(*) AS n')) return { n:jobs.size };
          if (sql.includes('FROM factory_jobs WHERE idempotency_key')) return jobs.get(a[0]) || null;
          if (sql.includes('SELECT role_id FROM hq_roles WHERE')) return roles.has(a[0]) ? { role_id:a[0] }:null;
          throw new Error('Unrecognized first query: '+sql);
        },
        async all() {
          if (sql.includes('FROM hq_roles')) return { results:[...roles.values()] };
          if (sql.includes('FROM factory_jobs WHERE source_system')) return {
            results:[...jobs.values()].map(x=>({ id:x.id, pipeline_id:x.pipeline_id, status:x.status,
              mode:'mock', input_json:x.input_json, actual_cost:0, budget_max:0, created_at:'test',updated_at:'test' }))
          };
          if (sql.includes('FROM hq_audit')) return { results:audit.map(x=>({ ...x, details_json:'{}'})) };
          throw new Error('Unrecognized all query: '+sql);
        },
        async run() {
          const a=this.args;
          if (sql.includes('INSERT OR IGNORE INTO factory_jobs')) {
            const key=a[5];
            if(jobs.has(key))return {meta:{changes:0}};
            jobs.set(key,{id:a[0],pipeline_id:a[1],input_json:a[4],status:'awaiting_review'});
            return {meta:{changes:1}};
          }
          if(sql.includes('INSERT INTO factory_events')){ events.push({id:a[0],job_id:a[1]});return {meta:{changes:1}}; }
          if(sql.includes('INSERT INTO hq_audit')){ audit.push({action:a[1],role_id:a[2],job_id:a[3]});return {meta:{changes:1}}; }
          if(sql.includes('UPDATE hq_roles SET status=')){
            const role=roles.get(a[2]);Object.assign(role,{status:a[0],appointed_name:a[1],connector_verified:0});
            return {meta:{changes:1}};
          }
          throw new Error('Unrecognized run query: '+sql);
        }
      };
    }
  };
  return db;
}
function req(method, path, body, key, origin=ORIGIN) {
  const headers={origin};
  if (key) headers['x-admin-key']=key;
  if(body)headers['content-type']='application/json';
  return new Request('https://threads-scheduler.gogototo24.workers.dev'+path,
    {method,headers, ...(body?{body:JSON.stringify(body)}:{})});
}

test('hard gates reject live, paid, publish and invalid pipeline',()=>{
  const valid={pipeline_id:'A',title:'TEST',brief:'SAFE MOCK',idempotency_key:'mock-abcdef'};
  assert.equal(validateMockJob(valid).pipeline_id,'A');
  for(const key of ['B','C','D'])assert.equal(HQ_PIPELINES.includes(key),true);
  assert.throws(()=>validateMockJob({...valid,mode:'live'}),/Mock/);
  assert.throws(()=>validateMockJob({...valid,paid_enabled:true}),/閘門/);
  assert.throws(()=>validateMockJob({...valid,publish_enabled:true}),/閘門/);
  assert.throws(()=>validateMockJob({...valid,publish:true}),/閘門/);
  assert.throws(()=>validateMockJob({...valid,budget_max_twd:1}),/閘門/);
  assert.throws(()=>validateMockJob({...valid,pipeline_id:'X'}),/A\/B\/C\/D/);
});

test('appointments do not assert connected credentials',()=>{
  assert.deepEqual(validateRoleUpdate('C',{status:'appointed',appointed_name:'Gemini'}),{
    role_id:'C',status:'appointed',appointed_name:'Gemini'
  });
  assert.throws(()=>validateRoleUpdate('C',{status:'appointed'}),/名稱/);
  assert.throws(()=>validateRoleUpdate('C',{status:'appointed',appointed_name:'Gemini',connector_verified:true}),/授權/);
});

test('CORS policy rejects foreign origins before admin key check',async()=>{
  const env={ADMIN_KEY:'very-secret',DB:mockDb()};
  const p=await handleHqRequest(req('OPTIONS','/api/factory/hq/jobs',null,null,'https://evil.example'),env);
  assert.equal(p.status,403);
  assert.equal(p.headers.get('access-control-allow-origin'),null);
  const ok=await handleHqRequest(req('OPTIONS','/api/factory/hq/jobs'),env);
  assert.equal(ok.status,204);
  assert.equal(ok.headers.get('access-control-allow-origin'),ORIGIN);
});

test('private mutations reject missing admin key',async()=>{
  const env={ADMIN_KEY:'very-secret',DB:mockDb()};
  const res=await handleHqRequest(req('POST','/api/factory/hq/mock-run',{batch_key:'batch-2026'}),env);
  assert.equal(res.status,401);
  assert.equal(env.DB.jobs.size,0);
});

test('public readiness returns only sanitized counts and never authorizes actions',async()=>{
  const env={ADMIN_KEY:'very-secret',DB:mockDb()};
  const res=await handleHqRequest(req('GET','/api/factory/hq/public'),env);
  assert.equal(res.status,200);
  const j=await res.json();
  assert.equal(j.paid_enabled,false);
  assert.equal(j.publish_enabled,false);
  assert.equal(j.mock_jobs,0);
  assert.equal(JSON.stringify(j).includes('very-secret'),false);
});

test('mock run writes exactly four idempotent, zero-cost review jobs',async()=>{
  const db=mockDb(),env={DB:db,ADMIN_KEY:'very-secret'};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('External network must not be invoked');};
  try{
    const path='/api/factory/hq/mock-run';
    const first=await handleHqRequest(req('POST',path,{batch_key:'hqmock-20261020'},'very-secret'),env);
    assert.equal(first.status,201);
    const result=await first.json();
    assert.equal(result.count,4);
    assert.equal(result.provider_calls,0);
    assert.equal(result.publish_calls,0);
    assert.equal(result.actual_cost_twd,0);
    assert.equal(db.jobs.size,4);
    assert.equal(db.events.length,4);
    for(const job of db.jobs.values())assert.equal(job.status,'awaiting_review');
    const second=await handleHqRequest(req('POST',path,{batch_key:'hqmock-20261020'},'very-secret'),env);
    assert.equal(second.status,201);
    const repeated=await second.json();
    assert.equal(repeated.jobs.filter(x=>x.deduplicated).length,4);
    assert.equal(db.jobs.size,4);
    assert.equal(db.events.length,4);
  }finally{ globalThis.fetch=originalFetch; }
});

test('appointing a candidate records status but keeps connector unverified',async()=>{
  const db=mockDb(),env={DB:db,ADMIN_KEY:'very-secret'};
  const r=await handleHqRequest(req('PATCH','/api/factory/hq/roles/HQ',
    {status:'appointed',appointed_name:'Gemini Enterprise'},'very-secret'),env);
  assert.equal(r.status,200);
  assert.equal(db.roles.get('HQ').connector_verified,0);
  assert.equal(db.roles.get('HQ').status,'appointed');
  assert.equal(db.audit.length,1);
});
