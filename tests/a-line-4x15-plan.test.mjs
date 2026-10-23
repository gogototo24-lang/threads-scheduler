import test from 'node:test';
import assert from 'node:assert/strict';
import {createA4x15Plan,nextReadyStage,verifyContinuationFrame} from '../src/a-line-4x15-plan.mjs';
function request(){
 return {title:'Alishan',provider:'runninghub',aspect_ratio:'9:16',
 master_image_url:'https://example.com/master.png',master_approved:true,
 paid_approved:true,budget_max_twd:250,publish_enabled:false,
 clips:Array.from({length:4},(_,i)=>({duration_seconds:15,
 prompt:'Female cat Alishan scene with dramatic action number '+i,
 ...(i?{continuity:'previous_clip_last_frame'}:{})}))};
}
test('four 15-second clips plus three tail frames and one composition',()=>{
 const plan=createA4x15Plan(request());
 assert.equal(plan.stages.filter(s=>s.type==='runninghub_video').length,4);
 assert.equal(plan.stages.filter(s=>s.type==='tail_frame_extraction').length,3);
 assert.equal(plan.stages.find(s=>s.id==='compose_60s').duration_seconds,60);
 assert.equal(plan.stages.at(-1).type,'manual_review');
 assert.equal(nextReadyStage(plan).id,'clip_1');
});
test('continuation requires preceding tail extraction',()=>{
 const p=createA4x15Plan(request());
 assert.equal(nextReadyStage(p,['clip_1']).id,'extract_tail_1');
 assert.equal(nextReadyStage(p,['clip_1','extract_tail_1']).id,'clip_2');
});
test('tail frame requires HTTPS',()=>{
 assert.equal(verifyContinuationFrame('https://example.com/tail.png'),'https://example.com/tail.png');
 assert.throws(()=>verifyContinuationFrame('http://example.com/tail.png'),/HTTPS/);
 assert.throws(()=>verifyContinuationFrame(''),/missing/);
});
