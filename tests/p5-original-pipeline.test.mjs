import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreTopic,prepareOriginalCandidate} from '../src/p5-original-pipeline.js';
const now=Date.now();
const base={title:'台灣文化藝術活動展覽近期開幕',summary:'主辦單位公告指出展覽在台灣舉行，時間與活動資訊皆有官方來源可以查詢與驗證。',published_at:new Date(now-3600000).toISOString(),verified_at:new Date(now).toISOString(),verified:true,source_checked:true,verification_attested_by:'trusted_official_scout',verification_method:'official',verification_urls:['https://www.taiwan.net.tw/example'],source_url:'https://www.taiwan.net.tw/example',search_traffic:12000};
test('verified nonpolitical topic gets score and universe',()=>{const r=scoreTopic(base,now);assert.equal(r.eligible,true);assert.equal(r.universe,'喵台灣宇宙');assert.ok(r.score>0)});
test('politics, stale and unverified topics fail closed',()=>{
 assert.equal(scoreTopic({...base,title:'總統選舉活動'},now).reason,'manual_review');
 assert.equal(scoreTopic({...base,verified:false},now).reason,'unverified');
 assert.equal(scoreTopic({...base,published_at:new Date(now-30*3600000).toISOString()},now).reason,'stale_or_invalid');
});
test('missing real provider never creates mock output',async()=>{
 const r=await prepareOriginalCandidate({AI_TEXT_PROVIDER:'mock'},base,now);
 assert.equal(r.status,'blocked');assert.equal(r.reason,'real_text_provider_not_configured');
});
