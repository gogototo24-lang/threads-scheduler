import { councilProviderStatus, runCouncilProvider } from './council-providers.js';

function now(){ return new Date().toISOString(); }
function id(prefix){ return prefix+'-'+crypto.randomUUID(); }
function safeJson(v,fallback={}){ try{return JSON.parse(v||'')}catch{return fallback} }

async function logEvent(env,jobId,type,payload={}){
  await env.DB.prepare(
    "INSERT INTO council_events (id,council_job_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)"
  ).bind(id('evt'),jobId,type,JSON.stringify(payload),now()).run();
}

async function turns(env,jobId){
  return (await env.DB.prepare(
    "SELECT * FROM council_turns WHERE council_job_id=? ORDER BY turn_order"
  ).bind(jobId).all()).results||[];
}

function config(env){
  const providers=councilProviderStatus(env);
  const enabled=String(env.FACTORY_P4_ENABLED||'').toLowerCase()==='true';
  const autoExecute=String(env.FACTORY_P4_AUTO_EXECUTE||'').toLowerCase()==='true';
  const allConfigured=providers.openai.configured&&providers.anthropic.configured&&providers.meta.configured;
  return {
    phase:'P4',
    version:'0.1',
    enabled,
    auto_execute:autoExecute,
    strict_three_model:true,
    providers,
    full_council_ready:enabled&&allConfigured,
    publish_enabled:String(env.FACTORY_PUBLISH_ENABLED||'').toLowerCase()==='true',
    rules:[
      'original_author_cannot_verify_own_work',
      'no_model_may_self_declare_completion',
      'judge_requires_cross_model_evidence',
      'execution_requires_verified_plan',
      'publishing_remains_separately_locked'
    ]
  };
}

export async function factoryP4Status(env){
  const cfg=config(env);
  let dbReady=true;
  try{ await env.DB.prepare("SELECT id FROM council_jobs LIMIT 1").first(); }
  catch{ dbReady=false; }
  return {
    ...cfg,
    database_ready:dbReady,
    full_council_ready:cfg.full_council_ready&&dbReady,
    missing:[
      !cfg.providers.openai.configured?'OPENAI_API_KEY':null,
      !cfg.providers.anthropic.configured?'ANTHROPIC_API_KEY':null,
      !cfg.providers.meta.configured?'META_MODEL_API_KEY':null,
      !cfg.enabled?'FACTORY_P4_ENABLED=true':null
    ].filter(Boolean),
    note:cfg.enabled
      ? 'P4 已啟用；僅議會決策，auto_execute 與 publish 仍由獨立開關控制。'
      : 'P4 已部署但保持安全鎖定，不會呼叫任何付費模型。'
  };
}

export async function factoryP4Create(request,env){
  const cfg=config(env);
  if(!cfg.enabled) throw new Error('P4 尚未解鎖：FACTORY_P4_ENABLED=false');
  if(!cfg.full_council_ready) throw new Error('三模型尚未全部配置，拒絕降級成單模型自說自話');

  const body=await request.json();
  const objective=String(body.objective||'').trim();
  const taskType=String(body.task_type||'general').trim().slice(0,80);
  const pipelineId=body.pipeline_id?String(body.pipeline_id).toUpperCase():null;
  const idem=String(body.idempotency_key||'').trim();
  if(objective.length<20) throw new Error('objective 太短');
  if(pipelineId&&!['A','B','C','D'].includes(pipelineId)) throw new Error('pipeline_id 必須為 A/B/C/D');
  if(!/^[A-Za-z0-9._:-]{8,120}$/.test(idem)) throw new Error('idempotency_key 格式錯誤');

  const prior=await env.DB.prepare("SELECT id,status FROM council_jobs WHERE idempotency_key=?").bind(idem).first();
  if(prior) return {ok:true,duplicate:true,job_id:prior.id,status:prior.status};

  const jobId=id('CPC');
  const created=now();
  const context=body.context&&typeof body.context==='object'?body.context:{};
  const constraints=Array.isArray(body.constraints)?body.constraints:[];
  const maxCost=Math.max(0,Number(body.max_cost_twd||0));
  await env.DB.prepare(
    "INSERT INTO council_jobs (id,schema_version,pipeline_id,task_type,objective,context_json,constraints_json,status,current_stage,manager_provider,proposer_provider,critic_provider,verifier_provider,auto_execute,max_cost_twd,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    jobId,'catpaw.council.v1',pipelineId,taskType,objective,JSON.stringify(context),JSON.stringify(constraints),
    'queued','proposal','openai','meta','anthropic','anthropic',
    cfg.auto_execute?1:0,maxCost,idem,created,created
  ).run();
  await logEvent(env,jobId,'council_created',{task_type:taskType,pipeline_id:pipelineId,auto_execute:cfg.auto_execute});
  return {ok:true,duplicate:false,job_id:jobId,status:'queued',stage:'proposal'};
}

export async function factoryP4Get(env,jobId){
  const job=await env.DB.prepare("SELECT * FROM council_jobs WHERE id=?").bind(jobId).first();
  if(!job) throw new Error('找不到 Council 任務');
  const t=await turns(env,jobId);
  const events=(await env.DB.prepare(
    "SELECT * FROM council_events WHERE council_job_id=? ORDER BY created_at DESC LIMIT 50"
  ).bind(jobId).all()).results||[];
  return {job,turns:t,events};
}

export async function factoryP4List(env,limit=20){
  const n=Math.max(1,Math.min(50,Number(limit)||20));
  const jobs=(await env.DB.prepare(
    "SELECT id,pipeline_id,task_type,status,current_stage,manager_provider,proposer_provider,critic_provider,verifier_provider,auto_execute,created_at,updated_at FROM council_jobs ORDER BY created_at DESC LIMIT ?"
  ).bind(n).all()).results||[];
  return {jobs};
}

function previousMaterial(rows){
  const result={};
  for(const row of rows){
    result[row.stage]=safeJson(row.output_json,{});
  }
  return result;
}

async function addTurn(env,job,{stage,role,provider,result,input}){
  const existing=await env.DB.prepare(
    "SELECT COALESCE(MAX(turn_order),0) AS n FROM council_turns WHERE council_job_id=?"
  ).bind(job.id).first();
  const order=Number(existing?.n||0)+1;
  const authorKey=provider+':'+role;
  await env.DB.prepare(
    "INSERT INTO council_turns (id,council_job_id,turn_order,stage,role,provider,model,author_key,input_json,output_json,status,usage_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    id('turn'),job.id,order,stage,role,provider,result.model||'',authorKey,
    JSON.stringify(input||{}),JSON.stringify(result.output||{}),'completed',
    JSON.stringify(result.usage||{}),now()
  ).run();
  await logEvent(env,job.id,'turn_completed',{stage,role,provider,model:result.model||''});
}

function assertIndependentVerifier(rows,verifierProvider){
  const judge=rows.find(x=>x.stage==='judge');
  if(!judge) throw new Error('缺少 judge turn');
  if(judge.provider===verifierProvider){
    throw new Error('獨立驗收規則阻擋：verifier 不可與 judge 使用同一 provider');
  }
}

function payload(job,rows,role,stage){
  return {
    role,
    stage,
    objective:job.objective,
    context:{
      ...(safeJson(job.context_json,{})),
      pipeline_id:job.pipeline_id,
      task_type:job.task_type
    },
    constraints:safeJson(job.constraints_json,[]),
    previous:previousMaterial(rows)
  };
}

async function runStage(env,job,stage,role,provider){
  const rows=await turns(env,job.id);
  const result=await runCouncilProvider(provider,env,payload(job,rows,role,stage));
  await addTurn(env,job,{stage,role,provider,result,input:{previous_turns:rows.length}});
  return result.output||{};
}

export async function processFactoryP4(env){
  const cfg=config(env);
  if(!cfg.enabled||!cfg.full_council_ready) return {enabled:cfg.enabled,processed:0,ready:cfg.full_council_ready};

  const jobs=(await env.DB.prepare(
    "SELECT * FROM council_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 3"
  ).all()).results||[];
  let processed=0;

  for(const job of jobs){
    try{
      const stage=String(job.current_stage||'proposal');
      await env.DB.prepare("UPDATE council_jobs SET status='running',updated_at=? WHERE id=?").bind(now(),job.id).run();

      if(stage==='proposal'){
        await runStage(env,job,'proposal','proposer','meta');
        await env.DB.prepare("UPDATE council_jobs SET current_stage='critique',updated_at=? WHERE id=?").bind(now(),job.id).run();
      }else if(stage==='critique'){
        await runStage(env,job,'critique','critic','anthropic');
        await env.DB.prepare("UPDATE council_jobs SET current_stage='revision',updated_at=? WHERE id=?").bind(now(),job.id).run();
      }else if(stage==='revision'){
        await runStage(env,job,'revision','reviser','meta');
        await env.DB.prepare("UPDATE council_jobs SET current_stage='judge',updated_at=? WHERE id=?").bind(now(),job.id).run();
      }else if(stage==='judge'){
        const verdict=await runStage(env,job,'judge','manager_judge','openai');
        await env.DB.prepare(
          "UPDATE council_jobs SET current_stage='verify',verdict_json=?,final_plan_json=?,updated_at=? WHERE id=?"
        ).bind(JSON.stringify(verdict),JSON.stringify(verdict?.execution_plan||[]),now(),job.id).run();
      }else if(stage==='verify'){
        const rows=await turns(env,job.id);
        assertIndependentVerifier(rows,'anthropic');
        const verification=await runStage(env,job,'verify','independent_verifier','anthropic');
        const verdict=String(verification?.verdict||'revise').toLowerCase();
        if(verdict==='approve'){
          await env.DB.prepare(
            "UPDATE council_jobs SET status='ready_for_execution',current_stage='complete',updated_at=? WHERE id=?"
          ).bind(now(),job.id).run();
          await logEvent(env,job.id,'council_verified',{verdict:'approve',auto_execute:Boolean(job.auto_execute)});
        }else{
          await env.DB.prepare(
            "UPDATE council_jobs SET status='needs_revision',current_stage='complete',updated_at=? WHERE id=?"
          ).bind(now(),job.id).run();
          await logEvent(env,job.id,'council_rejected',{verdict});
        }
      }
      processed++;
    }catch(e){
      await env.DB.prepare(
        "UPDATE council_jobs SET status='failed',updated_at=? WHERE id=?"
      ).bind(now(),job.id).run();
      await logEvent(env,job.id,'council_failed',{error:String(e).slice(0,1000)});
    }
  }
  return {enabled:true,processed,ready:true};
}
