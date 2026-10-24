import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOfficialSource} from '../src/p5-source-verifier.js';
const title='台灣秋季文化藝術展覽活動正式登場';
const topic={title,source_url:'https://www.taiwan.net.tw/example',published_at:new Date().toISOString()};
const html=(body)=>new Response(body,{status:200,headers:{'content-type':'text/html'}});
test('official page title corroboration passes',async()=>{
 const r=await verifyOfficialSource(topic,async()=>html('<html><head><meta property="article:published_time" content="'+new Date().toISOString().slice(0,10)+'"></head><body>'+title+'</body></html>'));
 assert.equal(r.ok,true);assert.equal(r.verification_attested_by,'trusted_official_scout');
});
test('reject external URL before any fetch',async()=>{
 let called=false;
 const r=await verifyOfficialSource({...topic,source_url:'https://127.0.0.1/private'},async()=>{called=true;return html(title)});
 assert.equal(r.ok,false);assert.equal(called,false);
});
test('reject missing title evidence and redirects',async()=>{
 assert.equal((await verifyOfficialSource(topic,async()=>html('unrelated content'))).reason,'title_not_supported_by_source');
 assert.equal((await verifyOfficialSource(topic,async()=>new Response('',{status:302,headers:{location:'https://evil.example'}}))).ok,false);
});
