// P5 verified original-content quality gate. No keyword-only or mock publishing.
const BANNED=/(?:這是 Google 台灣熱門搜尋關鍵字|你是因為哪段作品|你最近也在關注這個話題嗎|社群對這個話題討論熱烈)/i;
const SENSITIVE=/(?:選舉|罷免|政黨|總統|政治|性侵|死亡|詐騙|指控|戰爭|事故)/i;
const UNIVERSES=new Set(['喵台灣宇宙','貓掌江湖']);
export function assessOriginalContent(topic,draft,now=Date.now()){
 if(!topic||!draft)return {ok:false,reason:'missing_topic_or_draft'};
 if(!UNIVERSES.has(draft.universe))return {ok:false,reason:'unknown_universe'};
 const title=String(topic.title||'').trim(),summary=String(topic.summary||'').trim();
 const copy=String(draft.copy||'').trim();
 if(title.length<8||summary.length<35)return {ok:false,reason:'insufficient_verified_facts'};
 if(!/^https:\/\//.test(String(topic.source_url||'')))return {ok:false,reason:'source_required'};
 const verified=Date.parse(String(topic.verified_at||''));
 if(!Number.isFinite(verified)||verified>now+300000||now-verified>7200000)
  return {ok:false,reason:'verification_expired'};
 if(topic.verified!==true||topic.source_checked!==true)return {ok:false,reason:'source_not_verified'};
 if(topic.political||topic.high_risk||SENSITIVE.test(title+' '+summary+' '+copy))
  return {ok:false,reason:'manual_review_required'};
 if(draft.provider!=='openai'||draft.mock===true)return {ok:false,reason:'mock_forbidden'};
 if(copy.length<85||Array.from(copy).length>500||BANNED.test(copy))
  return {ok:false,reason:'low_quality_or_template'};
 if(!copy.includes(topic.source_url))return {ok:false,reason:'source_attribution_required'};
 if(!copy.includes('喵')&&!copy.includes('貓'))return {ok:false,reason:'missing_cat_universe_identity'};
 if(draft.universe==='貓掌江湖'&&topic.canon_approved!==true)
  return {ok:false,reason:'canon_master_not_approved'};
 if(draft.media_type&&draft.media_type!=='TEXT'){
  if(!['IMAGE','VIDEO'].includes(draft.media_type)||!draft.media_url||
    draft.media_verified!==true||draft.media_rights_cleared!==true)
   return {ok:false,reason:'media_not_verified'};
 }
 return {ok:true,reason:'verified_original_content'};
}
