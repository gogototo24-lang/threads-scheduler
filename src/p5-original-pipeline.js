// Verified topic -> original copy. No publishing side effects.
import {generateDrafts,providers} from './ai-engine.js';
import {assessOriginalContent} from './p5-original-quality.js';
const POLITICAL=/(?:選舉|政黨|總統|罷免|立委|兩岸|戰爭|詐騙|死亡|性侵)/i;
export function scoreTopic(topic,now=Date.now()){
 const age=(now-Date.parse(String(topic?.published_at||'')))/3600000;
 if(!Number.isFinite(age)||age<0||age>24)return {eligible:false,reason:'stale_or_invalid'};
 if(POLITICAL.test(String(topic.title||'')+' '+String(topic.summary||'')))return {eligible:false,reason:'manual_review'};
 if(topic.verified!==true||topic.source_checked!==true)return {eligible:false,reason:'unverified'};
 const searches=Math.max(0,Number(topic.search_traffic||0));
 const freshness=Math.round(30*(1-age/24));
 const heat=Math.min(35,Math.round(Math.log10(searches+1)*8));
 const relevance=/(?:布袋戲|霹靂|戲偶|武俠)/.test(topic.title)?25:/(?:旅遊|景點|貓|音樂|文化|美食|娛樂)/.test(topic.title)?20:8;
 return {eligible:true,score:freshness+heat+relevance,universe:relevance===25?'貓掌江湖':'喵台灣宇宙'};
}
export async function prepareOriginalCandidate(env,topic,now=Date.now()){
 const rank=scoreTopic(topic,now);
 if(!rank.eligible)return {status:'rejected',reason:rank.reason};
 if(!topic.source_url||!topic.verified_at)return {status:'rejected',reason:'source_verification_missing'};
 if(providers(env).text!=='openai'||!env.OPENAI_API_KEY)
  return {status:'blocked',reason:'real_text_provider_not_configured'};
 const drafts=await generateDrafts(env,topic);
 const draft=drafts.find(x=>x.universe===rank.universe);
 if(!draft)return {status:'blocked',reason:'universe_draft_missing'};
 const candidate={...draft,provider:'openai'};
 const verdict=assessOriginalContent(topic,candidate,now);
 if(!verdict.ok)return {status:'review_required',reason:verdict.reason,universe:rank.universe};
 return {status:'ready_for_publication_review',topic_score:rank.score,universe:rank.universe,
  draft:candidate,source_url:topic.source_url};
}
