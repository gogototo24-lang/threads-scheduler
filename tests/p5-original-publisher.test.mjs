import test from 'node:test';
import assert from 'node:assert/strict';
import {publishVerifiedOriginal} from '../src/p5-original-publisher.js';
const now=Date.now(),url='https://www.taiwan.net.tw/example';
const topic={title:'台灣秋季文化藝術展覽活動正式登場',summary:'官方公告已確認展覽主題、展出地點及活動日期，相關細節應以主辦單位最新公布內容為準。',source_url:url,verified_at:new Date(now).toISOString(),verified:true,source_checked:true,verification_method:'official',verification_urls:[url]};
const draft={universe:'喵台灣宇宙',provider:'openai',copy:'🐾 喵台灣宇宙的秋日探險出發！小橘喵帶著地圖走進城市藝文展區，發現原來週末也能安排一場文化尋寶。活動日期與入場細節請參考主辦單位公告，別把熱搜當成已證實的消息。你最想帶哪隻喵同行？來源：'+url};
test('no external publication without explicit production gates',async()=>{
 const r=await publishVerifiedOriginal({},topic,draft,now);
 assert.equal(r.published,false);assert.equal(r.reason,'publish_gate_closed');
});
test('unverified media never publishes',async()=>{
 const r=await publishVerifiedOriginal({},topic,{...draft,media_type:'IMAGE',media_url:'https://example.com/a.png'},now);
 assert.equal(r.reason,'media_not_verified');
});
test('approved media remains blocked until actual media publisher integrated',async()=>{
 const r=await publishVerifiedOriginal({},topic,{...draft,media_type:'IMAGE',media_url:'https://example.com/a.png',media_verified:true,media_rights_cleared:true},now);
 assert.equal(r.reason,'media_publisher_not_integrated');
});
