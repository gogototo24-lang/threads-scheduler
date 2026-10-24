import test from 'node:test';
import assert from 'node:assert/strict';
import {assessOriginalContent} from '../src/p5-original-quality.js';
const now=Date.now(),url='https://www.taiwan.net.tw/example';
const topic={title:'台灣秋季文化藝術展覽活動正式登場',summary:'官方公告已確認展覽主題、展出地點及活動日期，相關細節應以主辦單位最新公布內容為準。',source_url:url,verified_at:new Date(now).toISOString(),verified:true,source_checked:true};
const draft={universe:'喵台灣宇宙',provider:'openai',copy:'🐾 喵台灣宇宙的秋日探險出發！小橘喵帶著地圖走進城市藝文展區，發現原來週末也能安排一場文化尋寶。活動日期與入場細節請參考主辦單位公告，別把熱搜當成已證實的消息。你最想帶哪隻喵同行？來源：'+url};
test('verified original cat-universe copy passes',()=>assert.equal(assessOriginalContent(topic,draft,now).ok,true));
test('mock, keyword template, unverified source and media fail closed',()=>{
 for(const [t,d] of [[topic,{...draft,provider:'mock'}],[topic,{...draft,copy:'這是 Google 台灣熱門搜尋關鍵字'}],[{...topic,source_checked:false},draft],[topic,{...draft,media_type:'IMAGE',media_url:'https://example.com/a.png'}],[{...topic,political:true},draft]]){
  assert.equal(assessOriginalContent(t,d,now).ok,false);
 }
});
test('puppetry requires CANON approval',()=>{
 assert.equal(assessOriginalContent(topic,{...draft,universe:'貓掌江湖'},now).reason,'canon_master_not_approved');
});
