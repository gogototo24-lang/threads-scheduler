// P5 scout credential administration; server stores a hash, never the plaintext.
const GRAPH='https://graph.threads.net/v1.0';
const LIFE_MS=90*24*60*60*1000;
async function setting(env,key){
  return (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value||null;
}
async function storeSetting(env,key,value){
  await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
    .bind(key,String(value)).run();
}
function hex(bytes){return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
async function digest(s){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));}
function equalConstantTime(a,b){
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let delta=0;for(let i=0;i<a.length;i++)delta|=a.charCodeAt(i)^b.charCodeAt(i);return delta===0;
}
export async function isScopedScoutKey(request,env){
  const token=String(request.headers.get('x-p5-scout-key')||'');
  if(!/^p5s_[a-f0-9]{64}$/.test(token))return false;
  const saved=await setting(env,'p5_scoped_key_sha256');
  const expiry=Date.parse(await setting(env,'p5_scoped_key_expires_at')||'');
  if(!saved||!Number.isFinite(expiry)||Date.now()>=expiry)return false;
  return equalConstantTime(await digest(token),saved);
}
export async function p5AuthStatus(env){
  const token=await setting(env,'threads_access_token');
  const username=await setting(env,'threads_username');
  const expiresAt=await setting(env,'token_expires_at');
  const scoutStored=await setting(env,'p5_scoped_key_sha256');
  const scoutExpiresAt=await setting(env,'p5_scoped_key_expires_at');
  const response={
    worker_ready:!!env.DB,admin_secret_configured:!!env.ADMIN_KEY,
    threads_app_id_configured:!!env.THREADS_APP_ID,threads_app_secret_configured:!!env.THREADS_APP_SECRET,
    threads_token_stored:!!token,threads_account:username||null,
    threads_token_expires_at:expiresAt||null,threads_oauth_live_valid:false,oauth_error:null,
    scout_secret_env_configured:!!env.P5_SCOUT_KEY,
    scoped_key_issued:!!scoutStored,
    scoped_key_usable:!!scoutStored&&Date.parse(scoutExpiresAt||'')>Date.now(),
    scoped_key_expires_at:scoutExpiresAt||null,
    scout_external_client_connected:null,last_checked:new Date().toISOString()
  };
  if(token){
    try{
      const uri=GRAPH+'/me?'+new URLSearchParams({fields:'id,username',access_token:token});
      const r=await fetch(uri);
      const body=await r.json().catch(()=>({}));
      response.threads_oauth_live_valid=r.ok&&!!body.id;
      if(response.threads_oauth_live_valid)response.threads_account=String(body.username||username||'');
      else response.oauth_error=String(body?.error?.message||'Threads OAuth HTTP '+r.status).slice(0,180);
    }catch(e){response.oauth_error='Threads 驗證查詢失敗：'+String(e?.message||e).slice(0,130);}
  }else response.oauth_error='尚未儲存 Threads OAuth Token';
  return response;
}
export async function issueScopedScoutKey(request,env){
  // Same-origin JSON POST is mandatory; cross-site browser forms cannot rotate this key.
  if(request.headers.get('origin')!==new URL(request.url).origin)throw Error('來源驗證失敗');
  if(!(request.headers.get('content-type')||'').startsWith('application/json'))throw Error('必須使用 JSON');
  const body=await request.json();
  if(body?.confirm!=='ISSUE_SCOPED_P5_KEY')throw Error('確認碼錯誤');
  const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
  const secret='p5s_'+hex(bytes);
  const expiry=new Date(Date.now()+LIFE_MS).toISOString();
  await storeSetting(env,'p5_scoped_key_sha256',await digest(secret));
  await storeSetting(env,'p5_scoped_key_expires_at',expiry);
  await storeSetting(env,'p5_scoped_key_created_at',new Date().toISOString());
  return {ok:true,one_time_key:secret,expires_at:expiry,
    note:'只有這次會顯示金鑰；請放入可信任的海巡執行環境，不要上傳 GitHub 或貼到聊天'};
}
export function p5AuthPage(){
  const html=`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CatPaw｜P5 授權中心</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,"Noto Sans TC",sans-serif;background:#0c1425;color:#f4f5f8;margin:0;line-height:1.6}
main{max-width:720px;margin:auto;padding:30px 16px 65px}h1{font-size:28px;line-height:1.2;margin:8px 0 22px}
h2{font-size:20px;margin:0 0 10px}.card{background:#18263e;padding:19px;border:1px solid #40516d;border-radius:16px;margin:15px 0}
p,li{color:#bccbde}.accent{color:#f3d38d}.positive{color:#8bdabe}.warning{color:#f4c58d}.danger{color:#ffb4b4}
button,.button{display:inline-block;cursor:pointer;background:#324b6a;color:#fff;border:1px solid #657f9a;border-radius:10px;padding:12px 14px;font-size:15px;text-decoration:none;margin:5px 6px 5px 0;min-height:46px}
.primary{background:#f4d18b;color:#162035;border-color:#f4d18b;font-weight:700}
input{width:100%;padding:12px;border-radius:8px;background:#0a1424;border:1px solid #617490;color:#fff;font-size:14px}
small{color:#aebdd0}hr{border:0;border-top:1px solid #4c607b;margin:15px 0}code{font-size:13px}
</style></head><body><main>
<p class="accent">CATPAW AI FACTORY · P5</p><h1>🔐 24H 海巡授權中心</h1>
<p>這裡只檢查授權和建立受限海巡金鑰，絕不發文。你必須先在總控首頁以 ADMIN_KEY 登入。</p>
<section class="card"><h2>1｜Threads 官方 OAuth</h2>
<p id="oauth">讀取授權狀態中…</p>
<a class="button primary" href="/connect">連接／重新授權 Threads</a>
<button id="refresh" type="button">重新檢查</button>
<p><small>Threads OAuth 會要求你親自在 Meta 頁面同意 threads_basic 和 threads_content_publish。</small></p>
</section>
<section class="card"><h2>2｜海巡專用 Key（非 ADMIN_KEY）</h2>
<p id="scout">讀取金鑰狀態中…</p>
<button id="issue" class="primary" type="button">產生／輪替海巡專用金鑰</button>
<section id="secretBox" hidden><hr>
<p class="warning"><strong>金鑰只顯示一次。</strong>請放在可信任的 n8n 等服務的 Secrets，絕不能貼到聊天或公開 GitHub。</p>
<input id="oneTime" readonly autocomplete="off" spellcheck="false">
<button id="copy" type="button">複製金鑰</button><button id="hide" type="button">已保存，隱藏金鑰</button>
</section>
</section>
<section class="card"><h2>3｜接線驗收</h2><ol>
<li>Threads Token 通過官方 API 即時驗證。</li>
<li>海巡專用 Key 已安全放到實際海巡服務。</li>
<li>用該 Key 呼叫 <code>/api/factory/p5/fastlane/health</code> 取得 HTTP 200。</li>
<li>正式貼文須有 Threads ID 和公開連結，才能宣稱已發布。</li>
</ol><p>如果外部海巡沒有這把 Key，401 仍是正常的安全阻擋。</p></section>
<p id="notice" role="status"></p><a class="button" href="/">返回 Threads 總控</a>
</main><script>
const el=id=>document.getElementById(id);
async function fetchApi(method,path,body){
 const init={method,credentials:'same-origin',cache:'no-store'};
 if(body){init.headers={'content-type':'application/json'};init.body=JSON.stringify(body)}
 const response=await fetch('/api/factory/p5/auth/'+path,init);
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'HTTP '+response.status);
 return data;
}
async function refresh(){
 try{
 const s=await fetchApi('GET','status');
 el('oauth').textContent=(s.threads_oauth_live_valid?'✅ 已通過 Threads API：':'⚠️ 尚未驗證成功：')+
   (s.threads_account||'未連接')+(s.oauth_error?'（'+s.oauth_error+'）':'');
 el('oauth').className=s.threads_oauth_live_valid?'positive':'warning';
 el('scout').textContent=s.scoped_key_usable?'✅ 有效至 '+s.scoped_key_expires_at+
   '；外部客戶端是否接通：仍待驗證':
   (s.scout_secret_env_configured?'✅ 既有 P5_SCOUT_KEY Secret 已配置，但外部客戶端尚未驗證':'⚠️ 尚未設定受限海巡 Key');
 }catch(e){el('notice').textContent='讀取失敗：'+e.message;el('notice').className='danger'}
}
el('refresh').addEventListener('click',refresh);
el('issue').addEventListener('click',async()=>{
 if(!confirm('確定產生新金鑰？舊的網頁發行金鑰會立即失效。'))return;
 el('issue').disabled=true;
 try{
  const s=await fetchApi('POST','issue',{confirm:'ISSUE_SCOPED_P5_KEY'});
  el('oneTime').value=s.one_time_key;el('secretBox').hidden=false;
  el('notice').textContent='金鑰已建立。請僅存入可信任的執行環境 Secret 設定。';
  await refresh();
 }catch(e){el('notice').textContent='授權失敗：'+e.message}
 finally{el('issue').disabled=false}
});
el('copy').addEventListener('click',async()=>{
 try{await navigator.clipboard.writeText(el('oneTime').value);el('notice').textContent='已複製，請儲存到可信任海巡服務';}
 catch{el('oneTime').select();el('notice').textContent='請複製選取的 Key'}
});
el('hide').addEventListener('click',()=>{el('oneTime').value='';el('secretBox').hidden=true;el('notice').textContent='金鑰已隱藏';});
refresh();
</script></body></html>`;
  return new Response(html,{
    status:200,
    headers:{
      'content-type':'text/html; charset=utf-8',
      'cache-control':'no-store, max-age=0',
      'x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
      'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}
