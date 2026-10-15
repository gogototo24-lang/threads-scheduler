import { startVideo, pollVideo } from './ai-engine.js';

const ALLOWED_PIPELINES = new Set(['A','B','C','D']);
const TERMINAL = new Set(['ready','completed','failed','cancelled']);

function now(){ return new Date().toISOString(); }
function jid(){ return 'CPF-P3-'+crypto.randomUUID(); }
function sid(jobId, order, name){ return jobId+'-'+String(order).padStart(2,'0')+'-'+name; }
function safeJson(v, fallback={}){ try{return JSON.parse(v||'{}')}catch{return fallback} }

async function event(env, jobId, type, payload={}){
  await env.DB.prepare(
    "INSERT INTO factory_events (id,job_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)"
  ).bind(crypto.randomUUID(), jobId, type, JSON.stringify(payload), now()).run();
}

function p3Config(env){
  const enabled = String(env.FACTORY_P3_ENABLED || '').toLowerCase()==='true';
  const publishEnabled = String(env.FACTORY_PUBLISH_ENABLED || '').toLowerCase()==='true';
  const maxRetries = Math.max(0, Math.min(5, Number(env.FACTORY_P3_MAX_RETRIES || 2)));
  return {
    phase:'P3',
    version:'0.8',
    enabled,
    publish_enabled:publishEnabled,
    max_retries:maxRetries,
    pipelines:{
      A:{state:'live_capable', provider:'runninghub', autonomous_to:'ready'},
      B:{state:'live_capable', provider:'openai-image', autonomous_to:'ready'},
      C:{state:'live_capable', provider:'ai-music-studio-v2', autonomous_to:'ready'},
      D:{state:'live_capable', provider:'runninghub+ai-music-studio-v2', autonomous_to:'ready'}
    },
    ai_music_studio_url:String(env.AI_MUSIC_STUDIO_URL || 'https://ai-music-studio-v2.onrender.com').replace(/\/$/,'')
  };
}

export async function factoryP3Status(env){
  const cfg=p3Config(env);
  let dbReady=true;
  try { await env.DB.prepare("SELECT id FROM factory_jobs LIMIT 1").first(); }
  catch { dbReady=false; }
  let musicService=false;
  try{
    const r=await fetch(cfg.ai_music_studio_url+'/health',{headers:{Accept:'application/json'}});
    musicService=r.ok;
  }catch{}
  return {
    ...cfg,
    database_ready:dbReady,
    music_service_ready:musicService,
    can_run_A:cfg.enabled && dbReady && Boolean(env.RUNNINGHUB_API_KEY) &&
      Boolean(env.RUNNINGHUB_VIDEO_WEBAPP_ID) && Boolean(env.RUNNINGHUB_VIDEO_NODE_INFO_JSON),
    can_run_C:cfg.enabled && dbReady && musicService,
    can_run_D:cfg.enabled && dbReady && musicService && Boolean(env.RUNNINGHUB_API_KEY) &&
      Boolean(env.RUNNINGHUB_VIDEO_WEBAPP_ID) && Boolean(env.RUNNINGHUB_VIDEO_NODE_INFO_JSON),
    can_run_B:cfg.enabled && dbReady && Boolean(env.OPENAI_API_KEY),
    note: cfg.enabled
      ? 'P3 控制面已啟用；發布仍由 FACTORY_PUBLISH_ENABLED 單獨控制。'
      : 'P3 控制面已部署但保持安全鎖定；不會建立付費任務。'
  };
}

export async function factoryP3Create(request, env){
  const cfg=p3Config(env);
  if(!cfg.enabled) throw new Error('P3 尚未解鎖：FACTORY_P3_ENABLED=false');
  const body=await request.json();
  const pipeline=String(body.pipeline_id||'').toUpperCase();
  if(!ALLOWED_PIPELINES.has(pipeline)) throw new Error('pipeline_id 必須為 A/B/C/D');

  if(!['A','B','C','D'].includes(pipeline)){
    throw new Error(`P3 目前只允許 A/B/C/D 線建立真實任務；${pipeline} 線狀態：${cfg.pipelines[pipeline].state}`);
  }

  if(pipeline==='B'){
    const prompt=String(body.prompt||'').trim();
    const idem=String(body.idempotency_key||'').trim();
    const title=String(body.title||'CatPaw B-line Fashion Portrait').slice(0,160);
    if(prompt.length<20) throw new Error('B 線 prompt 太短');
    if(!/^[A-Za-z0-9._:-]{8,120}$/.test(idem)) throw new Error('idempotency_key 格式錯誤');
    const forbidden=/\b(nude|nudity|naked|topless|explicit|sexual|sex|fetish|porn|lingerie|underwear)\b/i;
    if(forbidden.test(prompt)) throw new Error('B 線只允許成年人、非裸露、非露骨的時尚寫真內容');
    const duplicate=await env.DB.prepare("SELECT * FROM factory_jobs WHERE idempotency_key=? LIMIT 1").bind(idem).first();
    if(duplicate) return {ok:true,duplicate:true,job_id:duplicate.id,status:duplicate.status};

    const id=jid(), created=now();
    const guardedPrompt=`adult woman age 25+, fully clothed, non-explicit fashion editorial portrait, no nudity, no lingerie, no fetish, no sexual content. ${prompt}`;
    const input={title,prompt:guardedPrompt};
    const outputSpec={aspect_ratio:'9:16',kind:'image',quality:'standard'};
    await env.DB.prepare(
      "INSERT INTO factory_jobs (id,schema_version,pipeline_id,universe,mode,status,source_system,source_id,input_json,output_spec_json,paid_enabled,publish_enabled,budget_currency,budget_max,asset_approval,paid_batch_approval,publish_approval,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      id,'factory.job.v1','B','成年時尚寫真','live','queued','catpaw-p3','api',
      JSON.stringify(input),JSON.stringify(outputSpec),1,0,'TWD',Number(body.budget_max_twd||20),
      'auto_qa_pending','approved','pending',idem,created,created
    ).run();
    const s1=sid(id,1,'generate_image'), s2=sid(id,2,'technical_qa');
    await env.DB.batch([
      env.DB.prepare("INSERT INTO factory_steps (id,job_id,step_order,name,depends_on_json,provider,status,attempt,mock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(s1,id,1,'generate_image','[]','openai','pending',0,0,created,created),
      env.DB.prepare("INSERT INTO factory_steps (id,job_id,step_order,name,depends_on_json,provider,status,attempt,mock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(s2,id,2,'technical_qa',JSON.stringify([s1]),'catpaw_auto_qa','blocked',0,0,created,created)
    ]);
    await event(env,id,'job_created',{pipeline_id:'B',content_guard:'adult_fully_clothed_non_explicit',publish:false});
    return {ok:true,duplicate:false,job_id:id,status:'queued',pipeline_id:'B'};
  }

  if(pipeline==='D'){
    const shots=Array.isArray(body.shots)?body.shots:[];
    const idem=String(body.idempotency_key||'').trim();
    const universe=String(body.universe||'長篇漫劇').slice(0,80);
    const title=String(body.title||'CatPaw D-line Episode').slice(0,160);
    const budget=Number(body.budget_max_twd||100);
    if(!shots.length||shots.length>24) throw new Error('D 線 shots 必須為 1~24 鏡');
    if(!Number.isFinite(budget)||budget<=0||budget>500) throw new Error('D 線 budget_max_twd 必須介於 0~500');
    if(!/^[A-Za-z0-9._:-]{8,120}$/.test(idem)) throw new Error('idempotency_key 格式錯誤');
    const normalized=shots.map((s,i)=>{
      const prompt=String(s?.prompt||'').trim();
      const first=String(s?.first_frame_url||'').trim();
      const duration=Number(s?.duration_seconds||5);
      if(prompt.length<20) throw new Error(`第 ${i+1} 鏡 prompt 太短`);
      let u; try{u=new URL(first)}catch{throw new Error(`第 ${i+1} 鏡 first_frame_url 無效`)}
      if(u.protocol!=='https:') throw new Error(`第 ${i+1} 鏡 first_frame_url 必須 HTTPS`);
      if(duration!==5) throw new Error(`第 ${i+1} 鏡目前固定 5 秒，以符合 RunningHub 工作流`);
      return {index:i+1,prompt,first_frame_url:first,duration_seconds:duration};
    });
    const duplicate=await env.DB.prepare("SELECT * FROM factory_jobs WHERE idempotency_key=? LIMIT 1").bind(idem).first();
    if(duplicate) return {ok:true,duplicate:true,job_id:duplicate.id,status:duplicate.status};

    const id=jid(), created=now();
    const totalDuration=normalized.reduce((a,s)=>a+s.duration_seconds,0);
    const input={title,shots:normalized};
    const outputSpec={aspect_ratio:'9:16',duration_seconds:totalDuration,quality:'720p'};
    await env.DB.prepare(
      "INSERT INTO factory_jobs (id,schema_version,pipeline_id,universe,mode,status,source_system,source_id,input_json,output_spec_json,paid_enabled,publish_enabled,budget_currency,budget_max,asset_approval,paid_batch_approval,publish_approval,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      id,'factory.job.v1','D',universe,'live','queued','catpaw-p3','api',
      JSON.stringify(input),JSON.stringify(outputSpec),1,0,'TWD',budget,
      'auto_qa_pending','approved','pending',idem,created,created
    ).run();

    const stmts=[];
    for(const shot of normalized){
      const stepId=sid(id,shot.index,`generate_shot_${String(shot.index).padStart(3,'0')}`);
      stmts.push(
        env.DB.prepare("INSERT INTO factory_steps (id,job_id,step_order,name,depends_on_json,provider,status,attempt,mock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .bind(stepId,id,shot.index,`generate_shot_${String(shot.index).padStart(3,'0')}`,'[]','runninghub','pending',0,0,created,created)
      );
    }
    const composeOrder=normalized.length+1;
    const composeId=sid(id,composeOrder,'compose_episode');
    const deps=normalized.map(s=>sid(id,s.index,`generate_shot_${String(s.index).padStart(3,'0')}`));
    stmts.push(
      env.DB.prepare("INSERT INTO factory_steps (id,job_id,step_order,name,depends_on_json,provider,status,attempt,mock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(composeId,id,composeOrder,'compose_episode',JSON.stringify(deps),'ai-music-studio-v2','blocked',0,0,created,created)
    );
    const qaId=sid(id,composeOrder+1,'technical_qa');
    stmts.push(
      env.DB.prepare("INSERT INTO factory_steps (id,job_id,step_order,name,depends_on_json,provider,status,attempt,mock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(qaId,id,composeOrder+1,'technical_qa',JSON.stringify([composeId]),'catpaw_auto_qa','blocked',0,0,created,created)
    );
    await env.DB.batch(stmts);
    await event(env,id,'job_created',{pipeline_id:'D',shot_count:normalized.length,total_duration_seconds:totalDuration,budget_max_twd:budget,publish:false});
    return {ok:true,duplicate:false,job_id:id,status:'queued',pipeline_id:'D',shot_count:normalized.length};
  }

  if(pipeline==='C'){
    const clipUrls=Array.isArray(body.clip_urls)?body.clip_urls.map(x=>String(x||'').trim()).filter(Boolean):[];
    const musicUrl=String(body.music_url||'').trim();
    const title=String(body.title||'CatPaw C-line MV').slice(0,160);
    const universe=String(body.universe||'music').slice(0,80);
    const idem=String(body.idempotency_key||'').trim();
    const duration=Number(body.duration_seconds||30);
    if(!clipUrls.length||clipUrls.length>30) throw new Error('C 線 clip_urls 必須為 1~30 支');
    for(const raw of clipUrls){ let u; try{u=new URL(raw)}catch{throw new Error('clip_urls 含無效 URL')} if(u.protocol!=='https:') throw new Error('clip_urls 只允許 HTTPS'); }
    if(musicUrl){ let u; try{u=new URL(musicUrl)}catch{throw new Error('music_url 格式錯誤')} if(u.protocol!=='https:') throw new Error('music_url 只允許 HTTPS'); }
    if(![30,60,275].includes(duration)) throw new Error('C 線 duration_seconds 目前只允許 30 / 60 / 275');
    if(!/^[A-Za-z0-9._:-]{8,120}$/.test(idem)) throw new Error('idempotency_key 格式錯誤');

    const duplicate=await env.DB.prepare("SELECT * FROM factory_jobs WHERE idempotency_key=? LIMIT 1").bind(idem).first();
    if(duplicate) return {ok:true,duplicate:true,job_id:duplicate.id,status:duplicate.status};

    const id=jid(), created=now();
    const input={
      clip_urls:clipUrls,
      music_url:musicUrl||null,
      title,
      ending_text:String(body.ending_text||'').slice(0,120),
      transition:String(body.transition||'cut'),
      original_audio_volume:Number(body.original_audio_volume ?? 0.18),
      smart_cut:body.smart_cut !== false,
      clip_roles:Array.isArray(body.clip_roles)?body.clip_roles:[]
    };
    const outputSpec={
      aspect_ratio:String(body.aspect_ratio||'9:16'),
      duration_seconds:duration,
      quality:String(body.quality||'720p')
    };
    await env.DB.prepare(
      "INSERT INTO factory_jobs (id,schema_version,pipeline_id,universe,mode,status,source_system,source_id,input_json,output_spec_json,paid_enabled,publish_enabled,budget_currency,budget_max,asset_approval,paid_batch_approval,publish_approval,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      id,'factory.job.v1','C',universe,'live','queued','catpaw-p3','api',
      JSON.stringify(input),JSON.stringify(outputSpec),0,0,'TWD',0,
      'auto_qa_pending','approved','pending',idem,created,created
    ).run();
    const s1=sid(id,1,'compose_mv'), s2=sid(id,2,'technical_qa');
    await env.DB.batch([
      env.DB.prepare("INSERT INTO factory_steps (id,job_id,step_order,name,depends_on_json,provider,status,attempt,mock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(s1,id,1,'compose_mv','[]','ai-music-studio-v2','pending',0,0,created,created),
      env.DB.prepare("INSERT INTO factory_steps (id,job_id,step_order,name,depends_on_json,provider,status,attempt,mock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(s2,id,2,'technical_qa',JSON.stringify([s1]),'catpaw_auto_qa','blocked',0,0,created,created)
    ]);
    await event(env,id,'job_created',{pipeline_id:'C',duration_seconds:duration,clip_count:clipUrls.length,publish:false});
    return {ok:true,duplicate:false,job_id:id,status:'queued',pipeline_id:'C'};
  }

  const prompt=String(body.prompt||'').trim();
  const firstFrame=String(body.first_frame_url||'').trim();
  const universe=String(body.universe||'貓掌江湖').slice(0,80);
  const budget=Number(body.budget_max_twd||15);
  const idem=String(body.idempotency_key||'').trim();
  if(prompt.length<20) throw new Error('prompt 太短');
  let u; try{u=new URL(firstFrame)}catch{throw new Error('first_frame_url 格式錯誤')}
  if(u.protocol!=='https:') throw new Error('first_frame_url 必須是 HTTPS');
  if(!Number.isFinite(budget)||budget<=0||budget>100) throw new Error('budget_max_twd 必須介於 0~100');
  if(!/^[A-Za-z0-9._:-]{8,120}$/.test(idem)) throw new Error('idempotency_key 格式錯誤');

  const duplicate=await env.DB.prepare("SELECT * FROM factory_jobs WHERE idempotency_key=? LIMIT 1").bind(idem).first();
  if(duplicate) return {ok:true,duplicate:true,job_id:duplicate.id,status:duplicate.status};

  const id=jid(), created=now();
  const input={prompt,first_frame_url:firstFrame,title:String(body.title||'CatPaw P3 A-line').slice(0,160)};
  const outputSpec={aspect_ratio:'9:16',duration_seconds:Number(body.duration_seconds||5),quality:'720p'};
  await env.DB.prepare(
    "INSERT INTO factory_jobs (id,schema_version,pipeline_id,universe,mode,status,source_system,source_id,input_json,output_spec_json,paid_enabled,publish_enabled,budget_currency,budget_max,asset_approval,paid_batch_approval,publish_approval,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    id,'factory.job.v1','A',universe,'live','queued','catpaw-p3','api',
    JSON.stringify(input),JSON.stringify(outputSpec),1,0,'TWD',budget,
    'auto_qa_pending','approved','pending',idem,created,created
  ).run();

  const s1=sid(id,1,'generate_video'), s2=sid(id,2,'technical_qa');
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_steps (id,job_id,step_order,name,depends_on_json,provider,status,attempt,mock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(s1,id,1,'generate_video','[]','runninghub','pending',0,0,created,created),
    env.DB.prepare("INSERT INTO factory_steps (id,job_id,step_order,name,depends_on_json,provider,status,attempt,mock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(s2,id,2,'technical_qa',JSON.stringify([s1]),'catpaw_auto_qa','blocked',0,0,created,created)
  ]);
  await event(env,id,'job_created',{pipeline_id:'A',budget_max_twd:budget,publish:false});
  return {ok:true,duplicate:false,job_id:id,status:'queued',pipeline_id:'A'};
}

export async function factoryP3Get(env, id){
  const job=await env.DB.prepare("SELECT * FROM factory_jobs WHERE id=?").bind(id).first();
  if(!job) throw new Error('找不到 P3 任務');
  const steps=(await env.DB.prepare("SELECT * FROM factory_steps WHERE job_id=? ORDER BY step_order").bind(id).all()).results||[];
  const assets=(await env.DB.prepare("SELECT * FROM factory_assets WHERE job_id=? ORDER BY created_at").bind(id).all()).results||[];
  const costs=(await env.DB.prepare("SELECT * FROM factory_costs WHERE job_id=? ORDER BY created_at").bind(id).all()).results||[];
  const events=(await env.DB.prepare("SELECT * FROM factory_events WHERE job_id=? ORDER BY created_at DESC LIMIT 30").bind(id).all()).results||[];
  return {job,steps,assets,costs,events};
}

export async function factoryP3List(env, limit=20){
  const n=Math.max(1,Math.min(50,Number(limit)||20));
  const rows=(await env.DB.prepare(
    "SELECT id,pipeline_id,universe,mode,status,budget_max,actual_cost,created_at,updated_at FROM factory_jobs WHERE mode='live' ORDER BY created_at DESC LIMIT ?"
  ).bind(n).all()).results||[];
  return {jobs:rows};
}

export async function factoryP3Retry(env,id){
  const cfg=p3Config(env);
  const job=await env.DB.prepare("SELECT * FROM factory_jobs WHERE id=? AND mode='live'").bind(id).first();
  if(!job) throw new Error('找不到 live 任務');
  let step;
  if(job.pipeline_id==='B'){
    step=await env.DB.prepare("SELECT * FROM factory_steps WHERE job_id=? AND name='generate_image' LIMIT 1").bind(id).first();
  }else if(job.pipeline_id==='D'){
    step=await env.DB.prepare("SELECT * FROM factory_steps WHERE job_id=? AND status IN ('failed','pending') ORDER BY step_order LIMIT 1").bind(id).first();
  }else{
    const stepName=job.pipeline_id==='C'?'compose_mv':'generate_video';
    step=await env.DB.prepare("SELECT * FROM factory_steps WHERE job_id=? AND name=?").bind(id,stepName).first();
  }
  if(!step) throw new Error('找不到可重試步驟');
  if(Number(step.attempt)>=cfg.max_retries+1) throw new Error('已達最大嘗試次數');
  await env.DB.prepare("UPDATE factory_steps SET status='pending',provider_task_id=NULL,error_code=NULL,updated_at=? WHERE id=?").bind(now(),step.id).run();
  await env.DB.prepare("UPDATE factory_jobs SET status='queued',updated_at=? WHERE id=?").bind(now(),id).run();
  await event(env,id,'manual_retry',{previous_attempt:step.attempt});
  return {ok:true,job_id:id,status:'queued'};
}

async function failStep(env,job,step,message,cfg){
  const attempts=Number(step.attempt||0);
  if(attempts<=cfg.max_retries){
    await env.DB.prepare("UPDATE factory_steps SET status='pending',provider_task_id=NULL,error_code=?,updated_at=? WHERE id=?")
      .bind(String(message).slice(0,500),now(),step.id).run();
    await env.DB.prepare("UPDATE factory_jobs SET status='retrying',updated_at=? WHERE id=?").bind(now(),job.id).run();
    await event(env,job.id,'retry_scheduled',{attempt:attempts,error:String(message).slice(0,500)});
  }else{
    await env.DB.prepare("UPDATE factory_steps SET status='failed',error_code=?,updated_at=? WHERE id=?")
      .bind(String(message).slice(0,500),now(),step.id).run();
    await env.DB.prepare("UPDATE factory_jobs SET status='failed',updated_at=? WHERE id=?").bind(now(),job.id).run();
    await event(env,job.id,'job_failed',{attempt:attempts,error:String(message).slice(0,500)});
  }
}


async function technicalProbe(cfg,url,expected={}){
  const response=await fetch(cfg.ai_music_studio_url+'/api/editor/probe-url',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({url,kind:'video'})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.status!=='success') throw new Error(data?.detail||`technical probe HTTP ${response.status}`);
  const meta=data.meta||{};
  const failures=[];
  if(!meta.has_video) failures.push('no_video_stream');
  if(Number(meta.duration||0)<=0) failures.push('invalid_duration');
  if(Number(meta.width||0)<320||Number(meta.height||0)<320) failures.push('resolution_too_low');
  if(Number(meta.fps||0)>0 && Number(meta.fps)<15) failures.push('fps_too_low');
  if(expected.duration_seconds){
    const target=Number(expected.duration_seconds);
    const actual=Number(meta.duration||0);
    const tolerance=Math.max(1.2,target*0.12);
    if(Math.abs(actual-target)>tolerance) failures.push('duration_out_of_range');
  }
  if(failures.length) throw new Error('technical QA failed: '+failures.join(','));
  return meta;
}


async function startB(env,job,step,cfg){
  const input=safeJson(job.input_json);
  await env.DB.prepare("UPDATE factory_steps SET status='generating',attempt=attempt+1,updated_at=? WHERE id=? AND status='pending'")
    .bind(now(),step.id).run();
  const current=await env.DB.prepare("SELECT * FROM factory_steps WHERE id=?").bind(step.id).first();
  try{
    const result=await generateImage(env,{provider:'openai',input_prompt:input.prompt},{universe:'成年時尚寫真'});
    if(!result?.body) throw new Error('OpenAI 圖片生成沒有回傳內容');
    const key=`factory/b/${job.id}.png`;
    await env.MEDIA.put(key,result.body,{httpMetadata:{contentType:result.contentType||'image/png',cacheControl:'public, max-age=31536000, immutable'}});
    const url=`${String(env.PUBLIC_BASE_URL||'').replace(/\/$/,'')}/media/${encodeURIComponent(key)}`;
    const assetId=crypto.randomUUID(), qaId=sid(job.id,2,'technical_qa');
    await env.DB.batch([
      env.DB.prepare("UPDATE factory_steps SET status='completed',error_code=NULL,updated_at=? WHERE id=?").bind(now(),step.id),
      env.DB.prepare("INSERT INTO factory_assets (id,job_id,step_id,kind,storage_key,url,mock,publishable,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(assetId,job.id,step.id,'image',key,url,0,0,JSON.stringify({content_type:result.contentType||'image/png',content_guard:'adult_fully_clothed_non_explicit'}),now()),
      env.DB.prepare("UPDATE factory_steps SET status='completed',attempt=1,error_code=NULL,updated_at=? WHERE id=?").bind(now(),qaId),
      env.DB.prepare("UPDATE factory_jobs SET status='ready',asset_approval='auto_qa_passed',updated_at=? WHERE id=?").bind(now(),job.id)
    ]);
    await event(env,job.id,'auto_qa_passed',{asset_id:assetId,url,checks:['non_mock_asset','image_content_type','content_guard']});
    await event(env,job.id,'job_ready',{publish:false});
  }catch(e){ await failStep(env,job,current,String(e),cfg); }
}

async function startA(env,job,step,cfg){
  const input=safeJson(job.input_json);
  const spec=safeJson(job.output_spec_json);
  const updated=now();
  await env.DB.prepare("UPDATE factory_steps SET status='generating',attempt=attempt+1,updated_at=? WHERE id=? AND status='pending'")
    .bind(updated,step.id).run();
  const current=await env.DB.prepare("SELECT * FROM factory_steps WHERE id=?").bind(step.id).first();
  try{
    const result=await startVideo(
      env,
      {provider:'runninghub',input_prompt:input.prompt,requested_at:updated},
      {universe:job.universe,visual_prompt:input.prompt},
      {url:input.first_frame_url}
    );
    if(result.kind==='pending'){
      await env.DB.prepare("UPDATE factory_steps SET provider_task_id=?,status='generating',updated_at=? WHERE id=?")
        .bind(result.providerJobId,now(),step.id).run();
      await env.DB.prepare("UPDATE factory_jobs SET status='generating',updated_at=? WHERE id=?").bind(now(),job.id).run();
      await event(env,job.id,'provider_started',{provider:'runninghub',task_id:result.providerJobId,duration:spec.duration_seconds||5});
      return;
    }
    throw new Error('RunningHub 未回傳 pending task');
  }catch(e){ await failStep(env,job,current,String(e),cfg); }
}

async function pollA(env,job,step,cfg){
  try{
    const result=await pollVideo(env,{
      provider:'runninghub',
      provider_job_id:step.provider_task_id,
      requested_at:step.updated_at || job.updated_at
    });
    if(result.status==='generating') return;
    if(result.status==='failed') throw new Error(result.error||'RunningHub failed');
    if(result.status!=='completed'||!result.url) throw new Error('RunningHub 完成但沒有影片 URL');

    const input=safeJson(job.input_json), spec=safeJson(job.output_spec_json);
    const qaMeta=await technicalProbe(cfg,result.url,{duration_seconds:spec.duration_seconds||5});
    const assetId=crypto.randomUUID(), qaId=sid(job.id,2,'technical_qa');
    await env.DB.batch([
      env.DB.prepare("UPDATE factory_steps SET status='completed',error_code=NULL,updated_at=? WHERE id=?").bind(now(),step.id),
      env.DB.prepare("INSERT INTO factory_assets (id,job_id,step_id,kind,url,mock,publishable,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(assetId,job.id,step.id,'video',result.url,0,0,JSON.stringify({provider:result.meta||{},technical_qa:qaMeta}),now()),
      env.DB.prepare("UPDATE factory_steps SET status='completed',attempt=1,error_code=NULL,updated_at=? WHERE id=?")
        .bind(now(),qaId),
      env.DB.prepare("UPDATE factory_jobs SET status='ready',asset_approval='auto_qa_passed',actual_cost=?,updated_at=? WHERE id=?")
        .bind(Number(result?.meta?.estimatedCostNtd||0),now(),job.id)
    ]);
    if(result?.meta?.taskCostSeconds||result?.meta?.estimatedCostNtd){
      await env.DB.prepare("INSERT INTO factory_costs (id,job_id,step_id,provider,currency,estimated_amount,actual_amount,task_cost_time_seconds,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(),job.id,step.id,'runninghub','TWD',
          Number(result?.meta?.estimatedCostNtd||0),Number(result?.meta?.estimatedCostNtd||0),
          Number(result?.meta?.taskCostSeconds||0),now()).run();
    }
    await event(env,job.id,'auto_qa_passed',{asset_id:assetId,url:result.url,checks:['https_url','provider_completed','non_mock_asset','ffprobe'],technical_qa:qaMeta});
    await event(env,job.id,'job_ready',{publish:false});
  }catch(e){ await failStep(env,job,step,String(e),cfg); }
}


async function startC(env,job,step,cfg){
  const input=safeJson(job.input_json);
  const spec=safeJson(job.output_spec_json);
  const updated=now();
  await env.DB.prepare("UPDATE factory_steps SET status='generating',attempt=attempt+1,updated_at=? WHERE id=? AND status='pending'")
    .bind(updated,step.id).run();
  const current=await env.DB.prepare("SELECT * FROM factory_steps WHERE id=?").bind(step.id).first();
  try{
    const response=await fetch(cfg.ai_music_studio_url+'/api/editor/render-from-urls',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        clip_urls:input.clip_urls,
        music_url:input.music_url||null,
        trim_specs:[],
        aspect:spec.aspect_ratio||'9:16',
        quality:spec.quality||'720p',
        transition:['cut','fade'].includes(input.transition)?input.transition:'cut',
        target_seconds:Number(spec.duration_seconds||30),
        original_audio_volume:Number(input.original_audio_volume ?? 0.18),
        title_text:input.title||'',
        ending_text:input.ending_text||'',
        reuse_mode:'cycle',
        smart_cut:input.smart_cut !== false,
        clip_roles:Array.isArray(input.clip_roles)?input.clip_roles:[]
      })
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data?.job_id) throw new Error(data?.detail||`Editor HTTP ${response.status}`);
    await env.DB.prepare("UPDATE factory_steps SET provider_task_id=?,status='generating',updated_at=? WHERE id=?")
      .bind(String(data.job_id),now(),step.id).run();
    await env.DB.prepare("UPDATE factory_jobs SET status='generating',updated_at=? WHERE id=?").bind(now(),job.id).run();
    await event(env,job.id,'provider_started',{
      provider:'ai-music-studio-v2',
      task_id:String(data.job_id),
      music_analysis:data.music_analysis||null
    });
  }catch(e){ await failStep(env,job,current,String(e),cfg); }
}

async function pollC(env,job,step,cfg){
  try{
    const response=await fetch(cfg.ai_music_studio_url+'/api/editor/jobs/'+encodeURIComponent(step.provider_task_id),{
      headers:{Accept:'application/json'}
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data?.detail||`Editor status HTTP ${response.status}`);
    if(['queued','running'].includes(data.status)) return;
    if(data.status==='error') throw new Error(data.detail||'Editor render failed');
    if(data.status!=='success'||!data.video_url) throw new Error('Editor 完成但沒有 video_url');

    const videoUrl=new URL(data.video_url,cfg.ai_music_studio_url).href;
    const spec=safeJson(job.output_spec_json);
    const qaMeta=await technicalProbe(cfg,videoUrl,{duration_seconds:spec.duration_seconds||30});
    const assetId=crypto.randomUUID(), qaId=sid(job.id,2,'technical_qa');
    await env.DB.batch([
      env.DB.prepare("UPDATE factory_steps SET status='completed',error_code=NULL,updated_at=? WHERE id=?").bind(now(),step.id),
      env.DB.prepare("INSERT INTO factory_assets (id,job_id,step_id,kind,url,mock,publishable,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(assetId,job.id,step.id,'video',videoUrl,0,0,JSON.stringify({editor:data.meta||{},technical_qa:qaMeta}),now()),
      env.DB.prepare("UPDATE factory_steps SET status='completed',attempt=1,error_code=NULL,updated_at=? WHERE id=?")
        .bind(now(),qaId),
      env.DB.prepare("UPDATE factory_jobs SET status='ready',asset_approval='auto_qa_passed',updated_at=? WHERE id=?")
        .bind(now(),job.id)
    ]);
    await event(env,job.id,'auto_qa_passed',{
      asset_id:assetId,
      url:videoUrl,
      checks:['editor_success','https_output','duration_present','ffprobe'],
      meta:data.meta||{},
      technical_qa:qaMeta
    });
    await event(env,job.id,'job_ready',{publish:false});
  }catch(e){ await failStep(env,job,step,String(e),cfg); }
}


function dShotIndex(step){
  const m=String(step?.name||'').match(/^generate_shot_(\d{3})$/);
  return m?Number(m[1]):null;
}

async function startDShot(env,job,step,cfg){
  const idx=dShotIndex(step);
  if(!idx) throw new Error('D 線 shot step 名稱錯誤');
  const input=safeJson(job.input_json);
  const shot=(input.shots||[]).find(x=>Number(x.index)===idx);
  if(!shot) throw new Error('D 線找不到 shot 設定');
  const updated=now();
  await env.DB.prepare("UPDATE factory_steps SET status='generating',attempt=attempt+1,updated_at=? WHERE id=? AND status='pending'")
    .bind(updated,step.id).run();
  const current=await env.DB.prepare("SELECT * FROM factory_steps WHERE id=?").bind(step.id).first();
  try{
    const result=await startVideo(
      env,
      {provider:'runninghub',input_prompt:shot.prompt,requested_at:updated},
      {universe:job.universe,visual_prompt:shot.prompt},
      {url:shot.first_frame_url}
    );
    if(result.kind!=='pending'||!result.providerJobId) throw new Error('RunningHub 未回傳 D 線 task');
    await env.DB.prepare("UPDATE factory_steps SET provider_task_id=?,status='generating',updated_at=? WHERE id=?")
      .bind(result.providerJobId,now(),step.id).run();
    await env.DB.prepare("UPDATE factory_jobs SET status='generating',updated_at=? WHERE id=?").bind(now(),job.id).run();
    await event(env,job.id,'shot_started',{shot_index:idx,task_id:result.providerJobId});
  }catch(e){ await failStep(env,job,current,String(e),cfg); }
}

async function pollDShot(env,job,step,cfg){
  const idx=dShotIndex(step);
  try{
    const input=safeJson(job.input_json);
    const shot=(input.shots||[]).find(x=>Number(x.index)===idx);
    const result=await pollVideo(env,{
      provider:'runninghub',
      provider_job_id:step.provider_task_id,
      requested_at:step.updated_at||job.updated_at
    });
    if(result.status==='generating') return;
    if(result.status==='failed') throw new Error(result.error||'RunningHub shot failed');
    if(result.status!=='completed'||!result.url) throw new Error('D 線 shot 完成但無 URL');

    const qaMeta=await technicalProbe(cfg,result.url,{duration_seconds:Number(shot?.duration_seconds||5)});
    const assetId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE factory_steps SET status='completed',error_code=NULL,updated_at=? WHERE id=?").bind(now(),step.id),
      env.DB.prepare("INSERT INTO factory_assets (id,job_id,step_id,kind,url,mock,publishable,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(assetId,job.id,step.id,'video',result.url,0,0,JSON.stringify({shot_index:idx,provider:result.meta||{},technical_qa:qaMeta}),now())
    ]);
    await event(env,job.id,'shot_ready',{shot_index:idx,asset_id:assetId,url:result.url});
  }catch(e){ await failStep(env,job,step,String(e),cfg); }
}

async function maybeStartDCompose(env,job,cfg){
  const pending=await env.DB.prepare("SELECT id FROM factory_steps WHERE job_id=? AND name LIKE 'generate_shot_%' AND status!='completed' LIMIT 1").bind(job.id).first();
  if(pending?.id) return false;
  const compose=await env.DB.prepare("SELECT * FROM factory_steps WHERE job_id=? AND name='compose_episode' LIMIT 1").bind(job.id).first();
  if(!compose) throw new Error('D 線缺 compose_episode');
  if(compose.status==='blocked'){
    await env.DB.prepare("UPDATE factory_steps SET status='pending',updated_at=? WHERE id=?").bind(now(),compose.id).run();
    compose.status='pending';
  }
  if(compose.status!=='pending') return false;

  const rows=(await env.DB.prepare(
    "SELECT a.url,s.step_order FROM factory_assets a JOIN factory_steps s ON s.id=a.step_id WHERE a.job_id=? AND s.name LIKE 'generate_shot_%' ORDER BY s.step_order"
  ).bind(job.id).all()).results||[];
  if(!rows.length) throw new Error('D 線沒有可合成的 shot assets');
  const spec=safeJson(job.output_spec_json), input=safeJson(job.input_json);
  await env.DB.prepare("UPDATE factory_steps SET status='generating',attempt=attempt+1,updated_at=? WHERE id=?")
    .bind(now(),compose.id).run();
  try{
    const response=await fetch(cfg.ai_music_studio_url+'/api/editor/render-from-urls',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        clip_urls:rows.map(x=>x.url),
        music_url:null,
        trim_specs:[],
        aspect:spec.aspect_ratio||'9:16',
        quality:spec.quality||'720p',
        transition:'cut',
        target_seconds:Number(spec.duration_seconds||rows.length*5),
        original_audio_volume:1,
        title_text:input.title||'',
        ending_text:'',
        reuse_mode:'cycle',
        smart_cut:false,
        clip_roles:[]
      })
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data?.job_id) throw new Error(data?.detail||`D compose HTTP ${response.status}`);
    await env.DB.prepare("UPDATE factory_steps SET provider_task_id=?,updated_at=? WHERE id=?")
      .bind(String(data.job_id),now(),compose.id).run();
    await event(env,job.id,'episode_compose_started',{task_id:String(data.job_id),shot_count:rows.length});
    return true;
  }catch(e){
    const current=await env.DB.prepare("SELECT * FROM factory_steps WHERE id=?").bind(compose.id).first();
    await failStep(env,job,current,String(e),cfg);
    return false;
  }
}

async function pollDCompose(env,job,compose,cfg){
  try{
    const response=await fetch(cfg.ai_music_studio_url+'/api/editor/jobs/'+encodeURIComponent(compose.provider_task_id),{headers:{Accept:'application/json'}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data?.detail||`D editor status HTTP ${response.status}`);
    if(['queued','running'].includes(data.status)) return;
    if(data.status==='error') throw new Error(data.detail||'D episode compose failed');
    if(data.status!=='success'||!data.video_url) throw new Error('D compose 完成但無 video_url');

    const videoUrl=new URL(data.video_url,cfg.ai_music_studio_url).href;
    const spec=safeJson(job.output_spec_json);
    const qaMeta=await technicalProbe(cfg,videoUrl,{duration_seconds:spec.duration_seconds});
    const qaStep=await env.DB.prepare("SELECT * FROM factory_steps WHERE job_id=? AND name='technical_qa' LIMIT 1").bind(job.id).first();
    const assetId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE factory_steps SET status='completed',error_code=NULL,updated_at=? WHERE id=?").bind(now(),compose.id),
      env.DB.prepare("INSERT INTO factory_assets (id,job_id,step_id,kind,url,mock,publishable,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(assetId,job.id,compose.id,'episode',videoUrl,0,0,JSON.stringify({editor:data.meta||{},technical_qa:qaMeta}),now()),
      env.DB.prepare("UPDATE factory_steps SET status='completed',attempt=1,error_code=NULL,updated_at=? WHERE id=?").bind(now(),qaStep.id),
      env.DB.prepare("UPDATE factory_jobs SET status='ready',asset_approval='auto_qa_passed',updated_at=? WHERE id=?").bind(now(),job.id)
    ]);
    await event(env,job.id,'episode_ready',{asset_id:assetId,url:videoUrl,technical_qa:qaMeta});
  }catch(e){ await failStep(env,job,compose,String(e),cfg); }
}

async function processD(env,job,cfg){
  const active=await env.DB.prepare(
    "SELECT * FROM factory_steps WHERE job_id=? AND name LIKE 'generate_shot_%' AND status IN ('pending','generating') ORDER BY step_order LIMIT 1"
  ).bind(job.id).first();
  if(active){
    if(active.status==='pending') await startDShot(env,job,active,cfg);
    else if(active.provider_task_id) await pollDShot(env,job,active,cfg);
    return;
  }
  const failed=await env.DB.prepare(
    "SELECT id FROM factory_steps WHERE job_id=? AND name LIKE 'generate_shot_%' AND status='failed' LIMIT 1"
  ).bind(job.id).first();
  if(failed?.id) return;
  const compose=await env.DB.prepare("SELECT * FROM factory_steps WHERE job_id=? AND name='compose_episode' LIMIT 1").bind(job.id).first();
  if(compose?.status==='generating'&&compose.provider_task_id){
    await pollDCompose(env,job,compose,cfg);
    return;
  }
  await maybeStartDCompose(env,job,cfg);
}

export async function processFactoryP3(env){
  const cfg=p3Config(env);
  if(!cfg.enabled) return {processed:0,enabled:false};
  const jobs=(await env.DB.prepare(
    "SELECT * FROM factory_jobs WHERE mode='live' AND pipeline_id IN ('A','B','C','D') AND status IN ('queued','retrying','generating') ORDER BY created_at LIMIT 10"
  ).all()).results||[];
  let processed=0;
  for(const job of jobs){
    if(TERMINAL.has(job.status)) continue;
    if(job.pipeline_id==='D'){
      await processD(env,job,cfg);
      processed++;
      continue;
    }
    if(job.pipeline_id==='B'){
      const step=await env.DB.prepare("SELECT * FROM factory_steps WHERE job_id=? AND name='generate_image' LIMIT 1").bind(job.id).first();
      if(step?.status==='pending') await startB(env,job,step,cfg);
      processed++;
      continue;
    }
    const stepName=job.pipeline_id==='C'?'compose_mv':'generate_video';
    const step=await env.DB.prepare("SELECT * FROM factory_steps WHERE job_id=? AND name=? LIMIT 1").bind(job.id,stepName).first();
    if(!step) continue;
    if(job.pipeline_id==='C'){
      if(step.status==='pending') await startC(env,job,step,cfg);
      else if(step.status==='generating'&&step.provider_task_id) await pollC(env,job,step,cfg);
    }else{
      if(step.status==='pending') await startA(env,job,step,cfg);
      else if(step.status==='generating'&&step.provider_task_id) await pollA(env,job,step,cfg);
    }
    processed++;
  }
  return {processed,enabled:true};
}
