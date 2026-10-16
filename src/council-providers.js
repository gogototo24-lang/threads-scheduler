const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const META_RESPONSES_URL = 'https://api.meta.ai/v1/responses';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

function requireSecret(value, name){
  if(!value) throw new Error(`尚未設定 ${name}`);
  return value;
}

function parseJsonLoose(text){
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fenced){
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const object = raw.match(/\{[\s\S]*\}/);
  if(object){
    try { return JSON.parse(object[0]); } catch {}
  }
  return { text: raw };
}

function responsesText(data){
  if(typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const parts = [];
  for(const item of data?.output || []){
    for(const c of item?.content || []){
      if(typeof c?.text === 'string') parts.push(c.text);
      if(typeof c?.output_text === 'string') parts.push(c.output_text);
    }
  }
  return parts.join('\n').trim();
}

function anthropicText(data){
  return (data?.content || [])
    .map(x => typeof x?.text === 'string' ? x.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function councilPrompt({role, stage, objective, context, constraints, previous}){
  return [
    'You are participating in CatPaw Factory P4 Multi-LLM Council.',
    `Role: ${role}`,
    `Stage: ${stage}`,
    'Return ONLY valid JSON. Do not wrap it in markdown.',
    'Never claim execution occurred unless evidence is present in the supplied context.',
    'Identify uncertainty explicitly.',
    '',
    'Objective:',
    objective,
    '',
    'Context JSON:',
    JSON.stringify(context || {}),
    '',
    'Constraints JSON:',
    JSON.stringify(constraints || []),
    '',
    'Previous council material JSON:',
    JSON.stringify(previous || {}),
    '',
    'Required JSON shape:',
    JSON.stringify({
      summary:'',
      findings:[],
      risks:[],
      recommendations:[],
      execution_plan:[],
      verdict:'revise|approve|reject',
      confidence:0
    })
  ].join('\n');
}

export function councilProviderStatus(env){
  return {
    openai:{
      configured:Boolean(env.OPENAI_API_KEY),
      model:String(env.COUNCIL_OPENAI_MODEL || 'gpt-6-luna'),
      role:'manager_judge'
    },
    anthropic:{
      configured:Boolean(env.ANTHROPIC_API_KEY),
      model:String(env.COUNCIL_ANTHROPIC_MODEL || 'claude-sonnet-4-5'),
      role:'critic_verifier'
    },
    meta:{
      configured:Boolean(env.META_MODEL_API_KEY),
      model:String(env.COUNCIL_META_MODEL || 'muse-spark-1.3'),
      role:'proposer_worker'
    }
  };
}

export async function runCouncilProvider(provider, env, payload){
  if(provider === 'openai') return runOpenAI(env, payload);
  if(provider === 'anthropic') return runAnthropic(env, payload);
  if(provider === 'meta') return runMeta(env, payload);
  throw new Error(`不支援的 Council provider：${provider}`);
}

async function runOpenAI(env, payload){
  requireSecret(env.OPENAI_API_KEY, 'OPENAI_API_KEY');
  const model = String(env.COUNCIL_OPENAI_MODEL || 'gpt-6-luna');
  const body = {
    model,
    input: councilPrompt(payload)
  };
  const r = await fetch(OPENAI_RESPONSES_URL,{
    method:'POST',
    headers:{
      Authorization:`Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body)
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${r.status}`);
  const text = responsesText(data);
  if(!text) throw new Error('OpenAI 未回傳文字');
  return {
    provider:'openai',
    model:data?.model || model,
    output:parseJsonLoose(text),
    usage:data?.usage || {}
  };
}

async function runMeta(env, payload){
  requireSecret(env.META_MODEL_API_KEY, 'META_MODEL_API_KEY');
  const model = String(env.COUNCIL_META_MODEL || 'muse-spark-1.3');
  const body = {
    model,
    input:councilPrompt(payload)
  };
  const r = await fetch(META_RESPONSES_URL,{
    method:'POST',
    headers:{
      Authorization:`Bearer ${env.META_MODEL_API_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body)
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data?.error?.message || data?.message || `Meta HTTP ${r.status}`);
  const text = responsesText(data);
  if(!text) throw new Error('Meta Muse 未回傳文字');
  return {
    provider:'meta',
    model:data?.model || model,
    output:parseJsonLoose(text),
    usage:data?.usage || {}
  };
}

async function runAnthropic(env, payload){
  requireSecret(env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY');
  const model = String(env.COUNCIL_ANTHROPIC_MODEL || 'claude-sonnet-4-5');
  const body = {
    model,
    max_tokens:Number(env.COUNCIL_ANTHROPIC_MAX_TOKENS || 5000),
    system:'You are a rigorous independent reviewer in a multi-model council. Return only valid JSON.',
    messages:[{
      role:'user',
      content:councilPrompt(payload)
    }]
  };
  const r = await fetch(ANTHROPIC_MESSAGES_URL,{
    method:'POST',
    headers:{
      'x-api-key':env.ANTHROPIC_API_KEY,
      'anthropic-version':'2023-06-01',
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body)
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data?.error?.message || `Anthropic HTTP ${r.status}`);
  const text = anthropicText(data);
  if(!text) throw new Error('Claude 未回傳文字');
  return {
    provider:'anthropic',
    model:data?.model || model,
    output:parseJsonLoose(text),
    usage:data?.usage || {}
  };
}
