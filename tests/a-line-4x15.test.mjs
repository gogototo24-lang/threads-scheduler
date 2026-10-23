import test from 'node:test';
import assert from 'node:assert/strict';
import {validateA4x15, assertRunningHub15sReady} from '../src/a-line-4x15.mjs';

const good = () => ({
 title:'阿里山・雲上末班車', provider:'runninghub', aspect_ratio:'9:16',
 master_image_url:'https://example.org/approved-master.png', master_approved:true,
 paid_approved:true, publish_enabled:false, budget_max_twd:200,
 clips:Array.from({length:4},(_,i)=>({
   duration_seconds:15, prompt:'Cinematic Alishan female cat puppet scene number '+(i+1),
   ...(i?{continuity:'previous_clip_last_frame'}:{})
 }))
});
test('valid 4x15 contract creates 60s unsubmitted plan',()=>{
 const result=validateA4x15(good());
 assert.equal(result.output_duration_seconds,60);
 assert.equal(result.state,'validated_not_submitted');
 assert.equal(result.clips[3].continuity,'previous_clip_last_frame');
});
test('reject wrong duration and count',()=>{
 const a=good();a.clips[0].duration_seconds=5;
 assert.throws(()=>validateA4x15(a),/15 seconds/);
 const b=good();b.clips.pop();
 assert.throws(()=>validateA4x15(b),/four clips/);
});
test('reject unapproved master and paid test',()=>{
 const a=good();a.master_approved=false;
 assert.throws(()=>validateA4x15(a),/Master image approval/);
 const b=good();b.paid_approved=false;
 assert.throws(()=>validateA4x15(b),/paid test approval/);
});
test('reject automatic publishing and broken continuity',()=>{
 const a=good();a.publish_enabled=true;
 assert.throws(()=>validateA4x15(a),/publishing/);
 const b=good();b.clips[1].continuity='new_seed';
 assert.throws(()=>validateA4x15(b),/tail frame/);
});
test('fail closed before real RunningHub mapping and compose verification',()=>{
 assert.throws(()=>assertRunningHub15sReady({}),/15s option/);
});
