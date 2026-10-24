// Server-side source verification for P5. Explicit official host allowlist;
// do not fetch arbitrary user-provided URLs (SSRF prevention).
const HOSTS=new Set(['www.taiwan.net.tw','taiwan.net.tw','www.travel.taipei','travel.taipei','www.pili.com.tw','pili.com.tw']);
export async function verifyOfficialSource(topic,fetcher=fetch,now=Date.now()){
 let url;
 try{url=new URL(String(topic?.source_url||''));}catch{return {ok:false,reason:'invalid_url'};}
 if(url.protocol!=='https:'||url.username||url.password||url.port||!HOSTS.has(url.hostname.toLowerCase()))
  return {ok:false,reason:'not_allowlisted_official_host'};
 const title=String(topic?.title||'').trim();
 if(title.length<8||title.length>180)return {ok:false,reason:'invalid_title'};
 let response;
 try{response=await fetcher(url.href,{method:'GET',redirect:'manual',headers:{Accept:'text/html,application/xml,text/xml,application/rss+xml'},signal:AbortSignal.timeout(10000)});}
 catch{return {ok:false,reason:'source_unreachable'};}
 if(!response.ok||response.status>=300)return {ok:false,reason:'source_unreachable'};
 const type=String(response.headers.get('content-type')||'').toLowerCase();
 if(!/(html|xml|rss)/.test(type))return {ok:false,reason:'invalid_source_type'};
 const contentLength=Number(response.headers.get('content-length')||0);
 if(contentLength>250000)return {ok:false,reason:'source_too_large'};
 const reader=response.body?.getReader();
 let body='';
 if(reader){
  const decoder=new TextDecoder();let bytes=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;
    if(bytes>250000){await reader.cancel();return {ok:false,reason:'source_too_large'};}
    body+=decoder.decode(value,{stream:true});}body+=decoder.decode();}
  finally{reader.releaseLock();}
 }else body=(await response.text()).slice(0,250000);
 const normalized=s=>String(s).replace(/<[^>]+>/g,' ').replace(/\s+/g,'').toLowerCase();
 const titleWords=normalized(title);
 if(titleWords.length<8||!normalized(body).includes(titleWords))
  return {ok:false,reason:'title_not_supported_by_source'};
 return {ok:true,source_url:url.href,verified_at:new Date(now).toISOString(),
  verification_method:'official',verification_urls:[url.href],verified:true,source_checked:true,
  verification_attested_by:'trusted_official_scout'};
}
