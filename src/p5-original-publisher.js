// P5 production publication contract: validate only real, verified original text.
// Media publication is intentionally held until an official Threads image/video
// upload + rights/CANON validation path is integrated and tested.
import {assessOriginalContent} from './p5-original-quality.js';
import {validateFastLaneSubmission,fastLaneSubmit} from './p5-fastlane.js';
import {processPublicActions} from './factory-p5.js';
export async function publishVerifiedOriginal(env,topic,draft,now=Date.now(),dispatch){
 const qa=assessOriginalContent(topic,draft,now);
 if(!qa.ok)return {published:false,status:'blocked',reason:qa.reason};
 if(draft.media_type&&draft.media_type!=='TEXT')
  return {published:false,status:'blocked',reason:'media_publisher_not_integrated'};
 if(String(env.FACTORY_P5_ORIGINAL_AUTO_SEND||'').toLowerCase()!=='true'||
    String(env.FACTORY_P5_AUTO_SEND||'').toLowerCase()!=='true'||
    String(env.FACTORY_P5_ALLOW_EXTERNAL_PUBLISH||'').toLowerCase()!=='true')
  return {published:false,status:'blocked',reason:'publish_gate_closed'};
 const body={title:topic.title,source_url:topic.source_url,category:draft.universe==='貓掌江湖'?'puppetry':'culture',
  text:draft.copy,verified_at:topic.verified_at,verification_method:topic.verification_method,
  verification_urls:topic.verification_urls,political:false,high_risk:false,
  contains_unlicensed_media:false,review_required:false};
 validateFastLaneSubmission(body,now);
 const req=new Request('https://threads-scheduler.gogototo24.workers.dev/api/factory/p5/fastlane',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
 });
 const result=await fastLaneSubmit(req,env,dispatch||((id)=>processPublicActions(env,{
  auto_send:true,hourly_action_limit:Math.max(1,Math.min(10,Number(env.FACTORY_P5_HOURLY_ACTION_LIMIT||10)))
 },id)));
 return {published:result.published===true&&!!result.thread_id&&!!result.permalink,
  status:result.status||'unknown',action_id:result.action_id||null,
  thread_id:result.thread_id||null,permalink:result.permalink||null};
}
