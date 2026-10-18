function now(){ return new Date().toISOString(); }
function id(prefix){ return prefix+'-'+crypto.randomUUID(); }
function clamp(v,min=0,max=100){ const n=Number(v); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):0; }
function safeJson(v,fallback={}){ try{return JSON.parse(v||'')}catch{return fallback} }

function config(env){
  const enabled=String(env.FACTORY_P5_ENABLED||'').toLowerCase()==='true';
  const autoSend=String(env.FACTORY_P5_AUTO_SEND||'').toLowerCase()==='true';
  const maxDaily=Math.max(1,Math.min(20,Number(env.FACTORY_P5_DAILY_REVIEW_LIMIT||8)));
  const minScore=Math.max(0,Math.min(100,Number(env.FACTORY_P5_MIN_SCORE||62)));
  return {
    phase:'P5',
    version:'0.3',
    enabled,
    auto_send:autoSend,
    allow_reply:String(env.FACTORY_P5_ALLOW_REPLY||'').toLowerCase()==='true',
    allow_quote:String(env.FACTORY_P5_ALLOW_QUOTE||'').toLowerCase()==='true',
    allow_repost:String(env.FACTORY_P5_ALLOW_REPOST||'').toLowerCase()==='true',
    allow_dm:false,
    hourly_action_limit:Math.max(1,Math.min(10,Number(env.FACTORY_P5_HOURLY_ACTION_LIMIT||10))),
    same_author_cooldown_hours:Math.max(1,Math.min(24,Number(env.FACTORY_P5_SAME_AUTHOR_COOLDOWN_HOURS||6))),
    platform:'threads',
    mode:'semi_automatic_review_first',
    daily_review_limit:maxDaily,
    min_score:minScore,
    rules:[
      'no_direct_messages',
      'no_impersonation',
      'no_mass_duplicate_replies',
      'political_or_high_risk_requires_human_review',
      'direct_messages_permanently_disabled',
      'same_author_rate_limited'
    ]
  };
}

function keywordScore(text,words,weight){
  const lower=String(text||'').toLowerCase();
  let hits=0;
  for(const w of words) if(lower.includes(String(w).toLowerCase())) hits++;
  return Math.min(100,hits*weight);
}

function scoreCandidate(input){
  const text=String(input.source_text||'');
  const topic=String(input.topic||'');
  const combined=`${text} ${topic}`;
  const metrics=input.metrics&&typeof input.metrics==='object'?input.metrics:{};
  const engagement=
    clamp(Number(metrics.likes||0)*0.5 + Number(metrics.replies||0)*2 + Number(metrics.reposts||0)*2.5 + Number(metrics.views||0)/1000,0,100);
  const freshness = input.age_hours==null ? 55 : clamp(100-(Number(input.age_hours)||0)*3,0,100);
  const heat=Math.round(clamp(engagement*0.7+freshness*0.3));

  const relevanceWords=['台灣','taiwan','貓','cat','ai','人工智慧','影片','shorts','threads','科技','交通','娛樂','生活','電影','音樂','mv'];
  const relevance=Math.round(clamp(35+keywordScore(combined,relevanceWords,9)));

  const questionLike=/[？?]|你覺得|大家|怎麼|為什麼|有沒有|推薦|誰知道/.test(text);
  const conversational=/哈哈|笑|太扯|原來|居然|真的|分享|第一次|沒想到/.test(text);
  const replyability=Math.round(clamp(40+(questionLike?35:0)+(conversational?20:0)));

  const political=/選舉|候選人|政黨|總統|立委|政治|罷免|戰爭|兩岸/.test(text);
  const harassment=/去死|垃圾|白癡|智障|人渣|仇恨|威脅/.test(text);
  const sensitive=/醫療|疾病|投資|股票|法律|犯罪|性|裸|私訊|約會/.test(text);
  const risk=Math.round(clamp((political?45:0)+(harassment?55:0)+(sensitive?30:0)));

  const traffic=Math.round(clamp(
    relevance*0.45 + replyability*0.35 + heat*0.2
  ));
  const total=Math.round(clamp(
    heat*0.25 + relevance*0.30 + replyability*0.20 + traffic*0.25 - risk*0.35
  ));
  const riskLevel=risk>=65?'high':risk>=35?'medium':'low';
  return {heat,relevance,replyability,risk,traffic,total,riskLevel};
}

function cleanExcerpt(text,max=70){
  return String(text||'').replace(/\s+/g,' ').trim().slice(0,max);
}

function accountReachScore(input){
  const avgViews=Math.max(0,Number(input.avg_views||0));
  const avgLikes=Math.max(0,Number(input.avg_likes||0));
  const avgReplies=Math.max(0,Number(input.avg_replies||0));
  const avgReposts=Math.max(0,Number(input.avg_reposts||0));
  const postsPerDay=Math.max(0,Number(input.posts_per_day||0));
  const viewScore=clamp(Math.log10(avgViews+1)*20);
  const conversationScore=clamp(avgReplies*3+avgReposts*4);
  const frequencyScore=clamp(postsPerDay*12);
  const engagementRate=avgViews>0?((avgLikes+avgReplies*2+avgReposts*2.5)/avgViews)*1000:0;
  const engagementScore=clamp(engagementRate*12);
  return Math.round(clamp(
    viewScore*0.35+conversationScore*0.25+frequencyScore*0.20+engagementScore*0.20
  ));
}

function breakoutScore(metrics,account){
  const views=Math.max(0,Number(metrics?.views||0));
  const replies=Math.max(0,Number(metrics?.replies||0));
  const reposts=Math.max(0,Number(metrics?.reposts||0));
  const avgViews=Math.max(0,Number(account?.avg_views||0));
  const relative=avgViews>0?clamp((views/avgViews)*45):clamp(Math.log10(views+1)*20);
  const conversation=views>0?clamp(((replies+reposts*1.5)/views)*5000):clamp(replies*4+reposts*5);
  return Math.round(clamp(relative*0.7+conversation*0.3));
}

function patrolScore(base,breakout,reach,relationship,risk){
  return Math.round(clamp(
    base*0.42+breakout*0.25+reach*0.20+relationship*0.13-risk*0.15
  ));
}

function normalizeHandle(v){
  return String(v||'').trim().replace(/^@/,'').toLowerCase().slice(0,160);
}

async function findAccount(env,platform,handle){
  const h=normalizeHandle(handle);
  if(!h) return null;
  return env.DB.prepare(
    "SELECT * FROM social_accounts WHERE platform=? AND lower(handle)=? LIMIT 1"
  ).bind(String(platform||'threads').toLowerCase(),h).first();
}

async function recalcRelationship(env,accountId){
  const row=await env.DB.prepare(
    "SELECT COALESCE(SUM(weight),0) AS score FROM social_relationship_events WHERE account_id=?"
  ).bind(accountId).first();
  const score=Math.round(clamp(Number(row?.score||0),0,100));
  await env.DB.prepare(
    "UPDATE social_accounts SET relationship_score=?,updated_at=? WHERE id=?"
  ).bind(score,now(),accountId).run();
  return score;
}

export async function factoryP5AccountIngest(request,env){
  const cfg=config(env);
  if(!cfg.enabled) throw new Error('P5 尚未啟用');
  const body=await request.json();
  const platform=String(body.platform||'threads').toLowerCase();
  const handle=normalizeHandle(body.handle);
  if(!handle) throw new Error('handle 不可空白');
  const metrics={
    followers:Math.max(0,Number(body.followers||0)),
    avg_views:Math.max(0,Number(body.avg_views||0)),
    avg_likes:Math.max(0,Number(body.avg_likes||0)),
    avg_replies:Math.max(0,Number(body.avg_replies||0)),
    avg_reposts:Math.max(0,Number(body.avg_reposts||0)),
    posts_per_day:Math.max(0,Number(body.posts_per_day||0)),
    observed_posts:Math.max(0,Number(body.observed_posts||0))
  };
  const reach=accountReachScore(metrics);
  const existing=await findAccount(env,platform,handle);
  const accountId=existing?.id||id('acct');
  const profileUrl=String(body.profile_url||'').trim()||null;
  if(profileUrl){
    let u; try{u=new URL(profileUrl)}catch{throw new Error('profile_url 格式錯誤')}
    if(u.protocol!=='https:') throw new Error('profile_url 必須為 HTTPS');
  }
  await env.DB.prepare(
    `INSERT INTO social_accounts
      (id,platform,handle,display_name,profile_url,category,followers,avg_views,avg_likes,avg_replies,avg_reposts,posts_per_day,observed_posts,reach_score,relationship_score,last_seen_at,metadata_json,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(platform,handle) DO UPDATE SET
      display_name=excluded.display_name,
      profile_url=excluded.profile_url,
      category=excluded.category,
      followers=excluded.followers,
      avg_views=excluded.avg_views,
      avg_likes=excluded.avg_likes,
      avg_replies=excluded.avg_replies,
      avg_reposts=excluded.avg_reposts,
      posts_per_day=excluded.posts_per_day,
      observed_posts=excluded.observed_posts,
      reach_score=excluded.reach_score,
      last_seen_at=excluded.last_seen_at,
      metadata_json=excluded.metadata_json,
      updated_at=excluded.updated_at`
  ).bind(
    accountId,platform,handle,String(body.display_name||'').slice(0,160),profileUrl,
    String(body.category||'').slice(0,100),metrics.followers,metrics.avg_views,metrics.avg_likes,
    metrics.avg_replies,metrics.avg_reposts,metrics.posts_per_day,metrics.observed_posts,reach,
    Number(existing?.relationship_score||0),now(),JSON.stringify(body.metadata||{}),existing?.created_at||now(),now()
  ).run();
  return {ok:true,account_id:accountId,handle,reach_score:reach,relationship_score:Number(existing?.relationship_score||0)};
}

export async function factoryP5RelationshipEvent(request,env,accountId){
  const body=await request.json();
  const weights={
    replied_to_us:25,
    we_replied:10,
    liked_us:8,
    reposted_us:20,
    followed_us:30,
    positive_reply_outcome:15,
    neutral_contact:3,
    ignored:-2
  };
  const type=String(body.event_type||'');
  if(!(type in weights)) throw new Error('不支援的 relationship event_type');
  const account=await env.DB.prepare("SELECT id FROM social_accounts WHERE id=?").bind(accountId).first();
  if(!account) throw new Error('找不到 social account');
  const sourceUrl=String(body.source_url||'').trim()||null;
  if(sourceUrl){
    let u; try{u=new URL(sourceUrl)}catch{throw new Error('source_url 格式錯誤')}
    if(u.protocol!=='https:') throw new Error('source_url 必須為 HTTPS');
  }
  await env.DB.prepare(
    "INSERT INTO social_relationship_events (id,account_id,event_type,weight,source_url,note,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(id('rel'),accountId,type,weights[type],sourceUrl,String(body.note||'').slice(0,500),body.occurred_at||now(),now()).run();
  const score=await recalcRelationship(env,accountId);
  return {ok:true,account_id:accountId,relationship_score:score};
}

export async function factoryP5HighReachRadar(env,limit=20){
  const n=Math.max(1,Math.min(50,Number(limit)||20));
  const rows=(await env.DB.prepare(
    `SELECT id,platform,handle,display_name,profile_url,category,followers,avg_views,avg_replies,
      avg_reposts,posts_per_day,observed_posts,reach_score,relationship_score,last_seen_at
     FROM social_accounts
     ORDER BY reach_score DESC,relationship_score DESC,last_seen_at DESC
     LIMIT ?`
  ).bind(n).all()).results||[];
  return {accounts:rows};
}

export async function factoryP5PatrolQueue(env,limit=8){
  const cfg=config(env);
  const n=Math.max(1,Math.min(cfg.daily_review_limit,Number(limit)||cfg.daily_review_limit));
  const rows=(await env.DB.prepare(
    `SELECT c.*,a.handle,a.display_name,a.profile_url,a.reach_score AS account_reach_score,
      a.relationship_score AS account_relationship_score
     FROM social_candidates c
     LEFT JOIN social_accounts a ON a.id=c.account_id
     WHERE c.status IN ('drafted','approved_for_manual_send')
     ORDER BY c.patrol_score DESC,c.breakout_score DESC,c.total_score DESC,c.created_at DESC
     LIMIT ?`
  ).bind(n).all()).results||[];
  for(const r of rows) r.metrics=safeJson(r.metrics_json,{});
  return {items:rows,auto_send:cfg.auto_send};
}

function draftVariants(candidate){
  const topic=cleanExcerpt(candidate.topic||candidate.source_text,40);
  const excerpt=cleanExcerpt(candidate.source_text,56);
  const persona=candidate.universe||'喵台灣宇宙';
  const base = persona==='貓掌江湖' ? '江湖' : '喵台灣';
  return [
    {
      variant:'natural',
      persona,
      reply_text:`${base}路過一下😸 這個「${topic}」真的很有共鳴，尤其你提到「${excerpt}」這段。`,
      rationale:'自然承接原文，不塞連結、不硬導流。'
    },
    {
      variant:'conversation',
      persona,
      reply_text:`看到這篇忍不住停下來😹 這個角度很有意思。你自己覺得最關鍵的是「${topic}」哪一點？`,
      rationale:'用問題延長對話，提高自然互動機會。'
    },
    {
      variant:'character',
      persona,
      reply_text: persona==='貓掌江湖'
        ? `此題若放進《貓掌江湖》，大概會變成「一招未出，江湖先炸鍋」😂 這個觀察真的很適合拍成短片。`
        : `喵台灣巡邏到這裡😸 這題材真的很有台灣日常感，留言區應該會很有戲。`,
      rationale:'保留品牌角色感，但避免直接宣傳或要求追蹤。'
    }
  ];
}

function qaDraft(text,candidate){
  const issues=[];
  if(text.length>300) issues.push('too_long');
  if(/https?:\/\//i.test(text)) issues.push('contains_link');
  if(/追蹤我|按讚我|來看我|私訊我|加我/.test(text)) issues.push('hard_self_promo');
  if(candidate.risk_level!=='low') issues.push('human_review_required');
  const pass=!issues.includes('too_long')&&!issues.includes('hard_self_promo');
  return {pass,issues,human_review_required:candidate.risk_level!=='low'};
}

async function insertDrafts(env,candidate){
  const variants=draftVariants(candidate);
  for(const v of variants){
    const qa=qaDraft(v.reply_text,candidate);
    await env.DB.prepare(
      "INSERT INTO social_reply_drafts (id,candidate_id,variant,persona,reply_text,rationale,qa_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      id('reply'),candidate.id,v.variant,v.persona,v.reply_text,v.rationale,JSON.stringify(qa),
      qa.pass?'pending_review':'qa_blocked',now(),now()
    ).run();
  }
}

async function addCandidate(env,input,sourceType='manual'){
  const sourceUrl=String(input.source_url||'').trim();
  const sourceText=String(input.source_text||'').trim();
  if(sourceText.length<8) throw new Error('source_text 太短');
  let u; try{u=new URL(sourceUrl)}catch{throw new Error('source_url 格式錯誤')}
  if(u.protocol!=='https:') throw new Error('source_url 必須為 HTTPS');

  const scored=scoreCandidate(input);
  const platform=String(input.platform||'threads').toLowerCase();
  const account=await findAccount(env,platform,input.source_author);
  const breakout=breakoutScore(input.metrics||{},account);
  const relationship=Math.round(clamp(Number(account?.relationship_score||0)));
  const reach=Math.round(clamp(Number(account?.reach_score||0)));
  const patrol=patrolScore(scored.total,breakout,reach,relationship,scored.risk);
  const candidate={
    id:id('soc'),
    platform,
    source_type:sourceType,
    source_url:sourceUrl,
    source_author:String(input.source_author||'').slice(0,160),
    source_text:sourceText.slice(0,4000),
    topic:String(input.topic||'').slice(0,300),
    universe:String(input.universe||'喵台灣宇宙').slice(0,80),
    metrics_json:JSON.stringify(input.metrics||{}),
    heat_score:scored.heat,
    relevance_score:scored.relevance,
    replyability_score:scored.replyability,
    risk_score:scored.risk,
    traffic_score:scored.traffic,
    total_score:scored.total,
    risk_level:scored.riskLevel,
    account_id:account?.id||null,
    breakout_score:breakout,
    relationship_score:relationship,
    patrol_score:patrol,
    source_thread_id:String(input.source_thread_id||'').trim()||null,
    status:'scored'
  };
  await env.DB.prepare(
    "INSERT INTO social_candidates (id,platform,source_type,source_url,source_author,source_text,topic,universe,metrics_json,heat_score,relevance_score,replyability_score,risk_score,traffic_score,total_score,risk_level,account_id,breakout_score,relationship_score,patrol_score,source_thread_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    candidate.id,candidate.platform,candidate.source_type,candidate.source_url,candidate.source_author,
    candidate.source_text,candidate.topic,candidate.universe,candidate.metrics_json,
    candidate.heat_score,candidate.relevance_score,candidate.replyability_score,candidate.risk_score,
    candidate.traffic_score,candidate.total_score,candidate.risk_level,candidate.account_id,
    candidate.breakout_score,candidate.relationship_score,candidate.patrol_score,candidate.source_thread_id,candidate.status,now(),now()
  ).run();
  return candidate;
}


async function getSetting(env,key){
  const row=await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return row?.value||null;
}

async function threadsPublishAction(env,action){
  const token=await getSetting(env,'threads_access_token');
  if(!token) throw new Error('尚未連接 Threads 帳號');
  const graph='https://graph.threads.net/v1.0';
  const target=String(action.target_thread_id||'').trim();
  if(!target) throw new Error('缺少 target_thread_id');

  if(action.action_type==='repost'){
    const r=await fetch(`${graph}/${encodeURIComponent(target)}/repost?access_token=${encodeURIComponent(token)}`,{method:'POST'});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data?.error?.message||`Threads repost HTTP ${r.status}`);
    return {thread_id:String(data?.id||target),permalink:null};
  }

  const params=new URLSearchParams({
    access_token:token,
    media_type:'TEXT',
    text:String(action.text||'').slice(0,500)
  });
  if(action.action_type==='reply') params.set('reply_to_id',target);
  if(action.action_type==='quote') params.set('quote_post_id',target);

  const created=await fetch(`${graph}/me/threads?${params}`,{method:'POST'});
  const createdJson=await created.json().catch(()=>({}));
  if(!created.ok||!createdJson.id) throw new Error(createdJson?.error?.message||'建立 Threads 容器失敗');

  const published=await fetch(`${graph}/me/threads_publish?${new URLSearchParams({
    access_token:token,
    creation_id:String(createdJson.id)
  })}`,{method:'POST'});
  const pub=await published.json().catch(()=>({}));
  if(!published.ok||!pub.id) throw new Error(pub?.error?.message||'Threads 發布失敗');
  return {thread_id:String(pub.id),permalink:null};
}

async function canSendNow(env,candidate,cfg){
  if(candidate.risk_level==='high') return {ok:false,reason:'high_risk_requires_human_review'};
  if(!candidate.source_thread_id) return {ok:false,reason:'missing_source_thread_id'};

  const hourAgo=new Date(Date.now()-3600000).toISOString();
  const sentHour=Number((await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM social_actions WHERE status='sent' AND sent_at>=?"
  ).bind(hourAgo).first())?.n||0);
  if(sentHour>=cfg.hourly_action_limit) return {ok:false,reason:'hourly_rate_limit'};

  const cooldown=new Date(Date.now()-cfg.same_author_cooldown_hours*3600000).toISOString();
  const recent=await env.DB.prepare(
    `SELECT a.id FROM social_actions a
     JOIN social_candidates c ON c.id=a.candidate_id
     WHERE a.status='sent' AND c.source_author=? AND a.sent_at>=?
     LIMIT 1`
  ).bind(candidate.source_author,cooldown).first();
  if(recent) return {ok:false,reason:'same_author_cooldown'};

  return {ok:true};
}

async function enqueueAutoReply(env,candidate,cfg){
  if(!cfg.auto_send||!cfg.allow_reply) return {queued:false,reason:'auto_reply_disabled'};
  const gate=await canSendNow(env,candidate,cfg);
  if(!gate.ok) return {queued:false,reason:gate.reason};

  const draft=await env.DB.prepare(
    `SELECT * FROM social_reply_drafts
     WHERE candidate_id=? AND status='pending_review' AND variant IN ('natural','conversation')
     ORDER BY CASE variant WHEN 'natural' THEN 1 ELSE 2 END, created_at
     LIMIT 1`
  ).bind(candidate.id).first();
  if(!draft) return {queued:false,reason:'no_safe_draft'};

  const duplicate=await env.DB.prepare(
    "SELECT id FROM social_actions WHERE text=? AND status IN ('queued','sent') LIMIT 1"
  ).bind(draft.reply_text).first();
  if(duplicate) return {queued:false,reason:'duplicate_text'};

  const actionId=id('act');
  await env.DB.prepare(
    `INSERT INTO social_actions
      (id,candidate_id,reply_draft_id,platform,action_type,target_thread_id,text,status,risk_level,scheduled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    actionId,candidate.id,draft.id,'threads','reply',candidate.source_thread_id,draft.reply_text,
    'queued',candidate.risk_level,now(),now(),now()
  ).run();
  await env.DB.prepare("UPDATE social_reply_drafts SET status='auto_approved',approved_at=?,updated_at=? WHERE id=?")
    .bind(now(),now(),draft.id).run();
  return {queued:true,action_id:actionId};
}

export async function factoryP5QueuePublicAction(request,env){
  const cfg=config(env);
  if(!cfg.enabled||!cfg.auto_send) throw new Error('P5 公開互動尚未啟用');
  const body=await request.json();
  const type=String(body.action_type||'').toLowerCase();
  if(!['reply','quote','repost'].includes(type)) throw new Error('action_type 只允許 reply/quote/repost');
  if(type==='reply'&&!cfg.allow_reply) throw new Error('reply 尚未開放');
  if(type==='quote'&&!cfg.allow_quote) throw new Error('quote 尚未開放');
  if(type==='repost'&&!cfg.allow_repost) throw new Error('repost 尚未開放');

  const target=String(body.target_thread_id||'').trim();
  if(!target) throw new Error('target_thread_id 不可空白');
  const risk=String(body.risk_level||'low').toLowerCase();
  if(risk==='high') throw new Error('高風險內容不得自動送出');

  const text=type==='repost'?'':String(body.text||'').trim();
  if(type!=='repost'&&text.length<2) throw new Error('text 太短');
  if(/私訊|dm me|direct message/i.test(text)) throw new Error('P5 禁止私訊導流');

  const actionId=id('act');
  await env.DB.prepare(
    `INSERT INTO social_actions
      (id,candidate_id,reply_draft_id,platform,action_type,target_thread_id,text,status,risk_level,scheduled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(actionId,body.candidate_id||null,body.reply_draft_id||null,'threads',type,target,text,'queued',risk,body.scheduled_at||now(),now(),now()).run();
  return {ok:true,action_id:actionId,status:'queued'};
}

export async function factoryP5ActionQueue(env,limit=50){
  const n=Math.max(1,Math.min(100,Number(limit)||50));
  const rows=(await env.DB.prepare(
    "SELECT * FROM social_actions ORDER BY created_at DESC LIMIT ?"
  ).bind(n).all()).results||[];
  return {actions:rows};
}

async function processPublicActions(env,cfg){
  if(!cfg.auto_send) return {sent:0,failed:0};
  const due=(await env.DB.prepare(
    "SELECT * FROM social_actions WHERE status='queued' AND (scheduled_at IS NULL OR scheduled_at<=?) ORDER BY created_at LIMIT ?"
  ).bind(now(),cfg.hourly_action_limit).all()).results||[];
  let sent=0,failed=0;
  for(const action of due){
    if(action.risk_level==='high'){
      await env.DB.prepare("UPDATE social_actions SET status='blocked',error=?,updated_at=? WHERE id=?")
        .bind('high_risk_requires_human_review',now(),action.id).run();
      continue;
    }
    try{
      const out=await threadsPublishAction(env,action);
      await env.DB.prepare(
        "UPDATE social_actions SET status='sent',external_thread_id=?,permalink=?,sent_at=?,error=NULL,updated_at=? WHERE id=?"
      ).bind(out.thread_id,out.permalink,now(),now(),action.id).run();
      if(action.candidate_id){
        await env.DB.prepare("UPDATE social_candidates SET status='sent',updated_at=? WHERE id=?")
          .bind(now(),action.candidate_id).run();
      }
      sent++;
    }catch(e){
      await env.DB.prepare("UPDATE social_actions SET status='failed',error=?,updated_at=? WHERE id=?")
        .bind(String(e).slice(0,700),now(),action.id).run();
      failed++;
    }
  }
  return {sent,failed};
}

export async function factoryP5Status(env){
  const cfg=config(env);
  let dbReady=true;
  try{ await env.DB.prepare("SELECT id FROM social_candidates LIMIT 1").first(); }catch{dbReady=false;}
  const counts={candidates:0,pending_review:0,approved:0,tracked_accounts:0,high_reach_accounts:0};
  if(dbReady){
    counts.candidates=Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM social_candidates").first())?.n||0);
    counts.pending_review=Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM social_reply_drafts WHERE status='pending_review'").first())?.n||0);
    counts.approved=Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM social_reply_drafts WHERE status='approved'").first())?.n||0);
    counts.tracked_accounts=Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM social_accounts").first())?.n||0);
    counts.high_reach_accounts=Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM social_accounts WHERE reach_score>=60").first())?.n||0);
  }
  return {
    ...cfg,
    database_ready:dbReady,
    ready:cfg.enabled&&dbReady,
    counts,
    note:cfg.enabled
      ? 'P5 v0.3 已啟用：公開 reply/quote/repost 可依風險與速率限制自動執行；DM 永久關閉。'
      : 'P5 已部署但保持關閉，不會掃描或送出社群互動。'
  };
}

export async function factoryP5Ingest(request,env){
  const cfg=config(env);
  if(!cfg.enabled) throw new Error('P5 尚未啟用：FACTORY_P5_ENABLED=false');
  const body=await request.json();
  const list=Array.isArray(body.candidates)?body.candidates:[body];
  if(!list.length||list.length>50) throw new Error('candidates 必須為 1~50 筆');
  const created=[];
  for(const item of list){
    const c=await addCandidate(env,item,'api');
    if(c.total_score>=cfg.min_score){
      await insertDrafts(env,c);
      await env.DB.prepare("UPDATE social_candidates SET status='drafted',updated_at=? WHERE id=?").bind(now(),c.id).run();
    }
    created.push({
      id:c.id,total_score:c.total_score,risk_level:c.risk_level,
      drafted:c.total_score>=cfg.min_score
    });
  }
  return {ok:true,created};
}

export async function factoryP5BootstrapFromTrends(env){
  const cfg=config(env);
  if(!cfg.enabled) throw new Error('P5 尚未啟用');
  const trends=(await env.DB.prepare(
    "SELECT id,title,summary,source_url,source_name,fetched_at,topic FROM trends WHERE source_url IS NOT NULL ORDER BY fetched_at DESC LIMIT 20"
  ).all()).results||[];
  let created=0,drafted=0;
  for(const t of trends){
    const exists=await env.DB.prepare("SELECT id FROM social_candidates WHERE source_url=? LIMIT 1").bind(t.source_url).first();
    if(exists) continue;
    const ageHours=t.fetched_at?Math.max(0,(Date.now()-new Date(t.fetched_at).getTime())/3600000):null;
    const c=await addCandidate(env,{
      platform:'threads',
      source_url:t.source_url,
      source_author:t.source_name||'',
      source_text:`${t.title||''}\n${t.summary||''}`,
      topic:t.topic||t.title||'',
      universe:'喵台灣宇宙',
      age_hours:ageHours,
      metrics:{}
    },'trend_bootstrap');
    created++;
    if(c.total_score>=cfg.min_score){
      await insertDrafts(env,c);
      await env.DB.prepare("UPDATE social_candidates SET status='drafted',updated_at=? WHERE id=?").bind(now(),c.id).run();
      drafted++;
    }
  }
  return {ok:true,created,drafted};
}

export async function factoryP5Queue(env,limit=8){
  const cfg=config(env);
  const n=Math.max(1,Math.min(cfg.daily_review_limit,Number(limit)||cfg.daily_review_limit));
  const rows=(await env.DB.prepare(
    `SELECT c.*, 
      (SELECT COUNT(*) FROM social_reply_drafts d WHERE d.candidate_id=c.id AND d.status='pending_review') AS draft_count
     FROM social_candidates c
     WHERE c.status='drafted'
     ORDER BY c.total_score DESC,c.created_at DESC
     LIMIT ?`
  ).bind(n).all()).results||[];
  for(const r of rows) r.metrics=safeJson(r.metrics_json,{});
  return {items:rows};
}

export async function factoryP5Candidate(env,candidateId){
  const candidate=await env.DB.prepare("SELECT * FROM social_candidates WHERE id=?").bind(candidateId).first();
  if(!candidate) throw new Error('找不到候選貼文');
  const drafts=(await env.DB.prepare(
    "SELECT * FROM social_reply_drafts WHERE candidate_id=? ORDER BY created_at"
  ).bind(candidateId).all()).results||[];
  const outcomes=(await env.DB.prepare(
    "SELECT * FROM social_outcomes WHERE candidate_id=? ORDER BY measured_at DESC"
  ).bind(candidateId).all()).results||[];
  return {candidate,drafts,outcomes};
}

export async function factoryP5Review(request,env,candidateId){
  const body=await request.json();
  const draftId=String(body.reply_draft_id||'');
  const action=String(body.action||'').toLowerCase();
  if(!['approve','reject'].includes(action)) throw new Error('action 只允許 approve/reject');
  const draft=await env.DB.prepare(
    "SELECT d.*,c.risk_level FROM social_reply_drafts d JOIN social_candidates c ON c.id=d.candidate_id WHERE d.id=? AND d.candidate_id=?"
  ).bind(draftId,candidateId).first();
  if(!draft) throw new Error('找不到回覆草稿');
  if(action==='approve'){
    await env.DB.prepare("UPDATE social_reply_drafts SET status='approved',approved_at=?,updated_at=? WHERE id=?")
      .bind(now(),now(),draftId).run();
    await env.DB.prepare("UPDATE social_candidates SET status='approved_for_manual_send',updated_at=? WHERE id=?")
      .bind(now(),candidateId).run();
    return {ok:true,status:'approved_for_manual_send',auto_send:false};
  }
  await env.DB.prepare("UPDATE social_reply_drafts SET status='rejected',updated_at=? WHERE id=?").bind(now(),draftId).run();
  return {ok:true,status:'rejected'};
}

export async function factoryP5RecordOutcome(request,env,candidateId){
  const body=await request.json();
  const draftId=body.reply_draft_id?String(body.reply_draft_id):null;
  await env.DB.prepare(
    "INSERT INTO social_outcomes (id,candidate_id,reply_draft_id,platform,external_reply_id,impressions,likes,replies,profile_visits,follows,measured_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    id('out'),candidateId,draftId,'threads',body.external_reply_id?String(body.external_reply_id):null,
    Math.max(0,Number(body.impressions||0)),Math.max(0,Number(body.likes||0)),Math.max(0,Number(body.replies||0)),
    Math.max(0,Number(body.profile_visits||0)),Math.max(0,Number(body.follows||0)),now(),JSON.stringify(body.metadata||{})
  ).run();
  await env.DB.prepare("UPDATE social_candidates SET status='measured',updated_at=? WHERE id=?").bind(now(),candidateId).run();
  return {ok:true};
}

export async function factoryP5Insights(env){
  const rows=(await env.DB.prepare(
    `SELECT d.variant,d.persona,
      COUNT(o.id) AS samples,
      SUM(o.impressions) AS impressions,
      SUM(o.likes) AS likes,
      SUM(o.replies) AS replies,
      SUM(o.profile_visits) AS profile_visits,
      SUM(o.follows) AS follows
     FROM social_outcomes o
     LEFT JOIN social_reply_drafts d ON d.id=o.reply_draft_id
     GROUP BY d.variant,d.persona
     ORDER BY impressions DESC`
  ).all()).results||[];
  return {performance:rows};
}

export async function processFactoryP5(env){
  const cfg=config(env);
  if(!cfg.enabled) return {enabled:false,processed:0};
  const undrafted=(await env.DB.prepare(
    "SELECT * FROM social_candidates WHERE status='scored' AND total_score>=? ORDER BY patrol_score DESC,total_score DESC LIMIT ?"
  ).bind(cfg.min_score,cfg.daily_review_limit).all()).results||[];
  let processed=0,autoQueued=0;
  for(const candidate of undrafted){
    await insertDrafts(env,candidate);
    await env.DB.prepare("UPDATE social_candidates SET status='drafted',updated_at=? WHERE id=?").bind(now(),candidate.id).run();
    const queued=await enqueueAutoReply(env,candidate,cfg);
    if(queued.queued) autoQueued++;
    processed++;
  }
  const actions=await processPublicActions(env,cfg);
  return {enabled:true,processed,auto_queued:autoQueued,auto_send:cfg.auto_send,...actions};
}
