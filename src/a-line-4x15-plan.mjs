// Pure, deterministic A-line 4x15 continuation planner.
// No network calls, secrets, provider billing, or publishing.
import { validateA4x15 } from './a-line-4x15.mjs';

export function createA4x15Plan(request) {
  const contract = validateA4x15(request);
  return {
    ...contract,
    stages: [
      ...contract.clips.map((clip, i) => ({
        id: 'clip_' + (i + 1),
        type: 'runninghub_video',
        status: i === 0 ? 'awaiting_provider_preflight' : 'blocked',
        depends_on: i === 0 ? [] : ['extract_tail_' + i],
        input_image_source: i === 0 ? 'approved_master' : 'previous_clip_tail',
        duration_seconds: 15,
        prompt: clip.prompt
      })).flatMap((clip, i) => i < 3 ? [
        clip,
        {id:'extract_tail_'+(i+1),type:'tail_frame_extraction',
         status:'blocked',depends_on:[clip.id],output:'https_image_url'}
      ] : [clip]),
      {id:'compose_60s',type:'video_composition',status:'blocked',
       depends_on:['clip_1','clip_2','clip_3','clip_4'],
       clip_order:[1,2,3,4],duration_seconds:60,transition:'cut'},
      {id:'technical_qa',type:'video_probe',status:'blocked',
       depends_on:['compose_60s'],expected_duration_seconds:60},
      {id:'human_review',type:'manual_review',status:'blocked',
       depends_on:['technical_qa']}
    ]
  };
}
export function nextReadyStage(plan, completedIds = []) {
  const done = new Set(completedIds);
  const stages = plan.stages.filter(s => !done.has(s.id) &&
    s.depends_on.every(dep => done.has(dep)));
  return stages.length ? stages[0] : null;
}
export function verifyContinuationFrame(frameUrl) {
  if(typeof frameUrl !== 'string') throw Error('tail frame URL missing');
  let u;
  try {u=new URL(frameUrl)} catch {throw Error('tail frame URL invalid');}
  if(u.protocol !== 'https:' || u.username || u.password)
    throw Error('tail frame must use safe HTTPS URL');
  return u.href;
}
