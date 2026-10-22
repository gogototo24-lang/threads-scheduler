// CatPaw P5 — broad topic viral intake and neutral political/person profiles.
// Discovery is not itself permission to copy a creator's media. Only the
// platform's native repost/quote endpoints or original attributed text are used.

const CIVIC=/(?:總統|副總統|立法院|立法委員|立委|議員|市長|縣長|政治|政黨|選舉|候選人|罷免|公投|政府首長|行政院)/i;
const ELECTION_MOBILIZATION=/(?:投給|票投|請投|支持.*(?:候選人|政黨|當選)|反對.*(?:候選人|政黨)|拒投|催票|拉票|助選|選戰|政黨動員|棄保|選前造勢|當選|下架.*(?:政府|政黨)|投票日)/i;
const HIGH_RISK=/(?:詐騙|死亡|傷亡|性侵|性騷|誹謗|貪污|收賄|外遇|私生活|洩密|刑事指控|指控|爆料|傳聞|流出|不雅|仇恨|威脅|自殺|血腥|內線交易)/i;
const ALL_SAFE_CATEGORIES=new Set([
 'entertainment','culture','cats','pets','puppetry','lifestyle','technology',
 'tourism','transport','music','sports','society','science','history','food',
 'education','fashion','economy','public_figure','politics_profile','trending'
]);

export function isPublicFigureProfile(raw) {
 return ['public_figure','politics_profile'].includes(String(raw.category||raw.topic_class||'').trim().toLowerCase())
   && String(raw.content_kind||'')==='biography';
}
export function verifyProfileInputs(raw) {
 if(!isPublicFigureProfile(raw))return {ok:false,reason:'not_person_profile'};
 const person=raw.person&&typeof raw.person==='object'?raw.person:{};
 const name=String(person.name||'').trim(),role=String(person.role||'').trim();
 if(name.length<2||name.length>65||role.length<2||role.length>100)return {ok:false,reason:'missing_public_profile_facts'};
 if(raw.neutral_facts_verified!==true)return {ok:false,reason:'facts_not_verified'};
 const links=Array.isArray(raw.verification_urls)?raw.verification_urls:[];
 if(links.length<2)return {ok:false,reason:'two_independent_sources_required'};
 const hosts=[];
 for(const link of links.slice(0,6)){
  try{
   const u=new URL(String(link));
   if(u.protocol!=='https:'||u.username||u.password) return {ok:false,reason:'invalid_verification_source'};
   hosts.push(u.hostname.toLowerCase().replace(/^www\./,''));
  }catch {return {ok:false,reason:'invalid_verification_source'};}
 }
 if(new Set(hosts).size<2)return {ok:false,reason:'two_distinct_source_domains_required'};
 const v=Date.parse(String(raw.verified_at||''));
 if(!Number.isFinite(v)||v>Date.now()+300000||Date.now()-v>24*3600000)
   return {ok:false,reason:'verification_is_stale'};
 return {ok:true,person:{name,role},sources:links.slice(0,6).map(String)};
}
function sliceCharacters(value,max){return Array.from(String(value||'').trim()).slice(0,max).join('');}
export function writeNeutralProfile(raw,details) {
 const person=details.person,source=String(raw.source_url||'').trim();
 return sliceCharacters(
   '👤 喵台灣人物焦點｜'+person.name+'\n'+
   '公開職務／身分：'+person.role+'\n'+
   '近期關注度上升，我們先整理可查證的人物資料，不替任何陣營背書。\n'+
   '想了解這位人物的哪一段公開經歷？\n來源：'+source,
   495
 );
}
export function assessViralTopic(raw,{riskLevel='low',heat=0,relevance=0}={}) {
 const category=String(raw.category||raw.topic_class||'trending').toLowerCase();
 const summary=[raw.title,raw.source_summary,raw.summary].map(x=>String(x||'')).join(' ');
 const civic=CIVIC.test(summary)||category==='politics_profile'||raw.political===true;
 const significantRisk=HIGH_RISK.test(summary)||raw.high_risk===true||raw.contains_unlicensed_media===true;
 const persuasion=ELECTION_MOBILIZATION.test(summary)||raw.persuasion===true;
 const rawVerifiedViews=Number(raw.metrics?.views||0);
 const viral=raw.metrics_verified===true && Number.isFinite(rawVerifiedViews)&&rawVerifiedViews>=100000;
 const a=Number(raw.age_hours);
 const fresh=Number.isFinite(a)&&a>=0&&a<=24;
 if(!ALL_SAFE_CATEGORIES.has(category))return {eligible:false,reason:'topic_requires_classification',risk_level:'medium',category};
 if(significantRisk||persuasion)return {eligible:false,reason:'sensitive_or_advocacy_requires_review',risk_level:'high',category};
 if(raw.content_rights==='unlicensed_copy')return {eligible:false,reason:'unlicensed_reupload_blocked',risk_level:'high',category};
 let risk=String(riskLevel);
 let text=null;
 if(civic){
   const profile=verifyProfileInputs(raw);
   if(!profile.ok)return {eligible:false,reason:'political_topic_requires_review:'+profile.reason,risk_level:'medium',category};
   text=writeNeutralProfile(raw,profile);
   risk='low';
 }else if(risk!=='low'){
   return {eligible:false,reason:'candidate_risk_requires_review',risk_level:risk,category};
 }
 const preference=String(raw.distribution_strategy||'original').toLowerCase();
 let action_type='original_post',target_thread_id=null;
 if(preference==='native_quote'||preference==='native_repost') {
   // Only repost source posts through a native public Threads action, not by
   // copying the other author's image, video or whole text into a new post.
   let originHost='';
   try{originHost=new URL(String(raw.source_url)).hostname.toLowerCase();}catch{}
   const trustedHost=['threads.com','www.threads.com','threads.net','www.threads.net'].includes(originHost);
   const id=String(raw.target_thread_id||'').trim();
   if(!trustedHost||!/^\d{8,32}$/.test(id)||raw.original_post_public!==true)
     return {eligible:false,reason:'native_target_not_verified',risk_level:'medium',category};
   if(civic && preference==='native_repost')
     return {eligible:false,reason:'political_native_repost_requires_review',risk_level:'medium',category};
   action_type=preference==='native_repost'?'repost':'quote';
   target_thread_id=id;
 }
 if(!fresh)return {eligible:false,reason:'not_recent_enough_for_autopost',risk_level:risk,category};
 const heatScore=Number(heat)||0,relevanceScore=Number(relevance)||0;
 if(!viral&&(heatScore<55||relevanceScore<55))
   return {eligible:false,reason:'below_viral_threshold',risk_level:risk,category};
 return {
  eligible:true,reason:civic?'verified_neutral_profile':'verified_low_risk_trend',
  risk_level:'low',category,viral,action_type,target_thread_id,
  text,priority:viral?'high':'normal'
 };
}
