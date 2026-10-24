import test from 'node:test';
import assert from 'node:assert/strict';
import {runTrendAutoPublisher} from '../src/p5-trends-autopost.js';

test('keyword-only radar must never publish or mutate D1', async () => {
 let dbCalls=0, publishCalls=0;
 const env={FACTORY_P5_TREND_AUTOPOST_ENABLED:'true',FACTORY_P5_AUTO_SEND:'true',FACTORY_P5_ALLOW_EXTERNAL_PUBLISH:'true',DB:{prepare(){dbCalls++;throw Error('D1 must not be touched');}}};
 const result=await runTrendAutoPublisher(env,Date.now(),async()=>{publishCalls++;throw Error('must not publish');});
 assert.equal(result.reason,'original_content_pipeline_required');
 assert.equal(result.published,0);
 assert.equal(result.attempted,0);
 assert.equal(dbCalls,0);
 assert.equal(publishCalls,0);
});
