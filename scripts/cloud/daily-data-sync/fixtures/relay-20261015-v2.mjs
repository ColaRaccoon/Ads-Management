const UPSTREAM='https://phase08-daily-data-sync-production.up.railway.app/backend-api/internal/daily-sync';
export const RELAY_TIMEOUT_MS=75000;
export const ORIGINAL_SCHEDULES=Object.freeze([
 {key:'phase08-cafe24',anchor:'2026-10-14T17:00:00.000Z',days:1,window:110},
 {key:'phase08-google',anchor:'2026-10-14T17:01:00.000Z',days:7,window:90},
 {key:'phase08-meta',anchor:'2026-10-14T17:02:00.000Z',days:7,window:90}]);
export const SCHEDULES=Object.freeze(ORIGINAL_SCHEDULES.map((row,index)=>Object.freeze({...row,anchor:`2026-10-15T01:0${index}:00.000Z` })));
const statuses=new Set(['NOT_STARTED','QUEUED','RUNNING','PARTIAL','FAILED','ACTION_REQUIRED','CANCELLED','SUCCEEDED','DELAYED','EXPIRED']);
const codes=new Set(['SOURCE_SELECTION_REQUIRED','ACCOUNT_SCOPE_MISMATCH','CURRENCY_MISMATCH','TIMEZONE_MISMATCH','FIELD_UNSUPPORTED','ATTRIBUTION_MISMATCH','PARTIAL_PAGE','RECONCILIATION_FAILED','LEASE_LOST','RUN_LIMIT_EXCEEDED','PROVIDER_AUTH_REQUIRED','PROVIDER_RATE_LIMITED','PROVIDER_UNAVAILABLE','PROVIDER_VERSION_UNVERIFIED','MACHINE_SYNC_FORBIDDEN']);
const response=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
const reject=(status,code)=>response(status,{code});
function canonicalSecret(value) {if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))return false;try{return atob(value).length===32&&btoa(atob(value))===value;}catch{return false;}}
function constantEqual(left,right) {const encoder=new TextEncoder(),a=encoder.encode(left),b=encoder.encode(right);try{let diff=a.length^b.length;for(let i=0;i<b.length;i++)diff|=(a[i]??0)^b[i];return diff===0;}finally{a.fill(0);b.fill(0);}}
function withAbort(promise,signal) {
 if(signal.aborted)return Promise.reject(new Error('ABORT'));
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(new Error('ABORT'));};signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted){if(value instanceof Response)value.body?.cancel().catch(()=>{});reject(new Error('ABORT'));}else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
async function boundedText(stream,maximum,signal) {
 if(!stream)return '';const reader=stream.getReader();let length=0;const chunks=[];
 try {while(true){if(signal?.aborted)throw new Error('ABORT');const part=await withAbort(reader.read(),signal);if(part.done)break;length+=part.value.byteLength;if(length>maximum)throw new Error('BOUND');chunks.push(part.value);}
  const all=new Uint8Array(length);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}return new TextDecoder('utf-8',{fatal:true}).decode(all);
 }finally{reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createRelayHandler({env,request=fetch,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
 return async req=>{
  let timer,upstream,raw='';const controller=new AbortController();
  try {
   if(!canonicalSecret(env?.basicPassword)||!canonicalSecret(env?.machineToken)||env.basicPassword===env.machineToken)return reject(503,'RELAY_CONFIGURATION_REQUIRED');
   const auth=req.headers.get('authorization')??'';const expected='Basic '+btoa('phase08-scheduler:'+env.basicPassword);
   if(auth.length>256||!constantEqual(auth,expected))return reject(403,'RELAY_FORBIDDEN');
   const url=new URL(req.url);
   if(req.method!=='POST'||url.search||url.hash||!['/functions/v1/phase08-scheduled-relay','/phase08-scheduled-relay'].includes(url.pathname))return reject(400,'RELAY_REQUEST_REJECTED');
   if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers.get('content-type')??''))return reject(400,'RELAY_REQUEST_REJECTED');
   timer=setTimer(()=>controller.abort(),RELAY_TIMEOUT_MS);
   let body;try{raw=await boundedText(req.body,1024,controller.signal);body=JSON.parse(raw);}catch{return reject(controller.signal.aborted?504:400,controller.signal.aborted?'RELAY_TIMEOUT':'RELAY_REQUEST_REJECTED');}
   const readOnly=body?.mode==='status',fields=readOnly?['mode','scheduleKey','scheduledFor']:['scheduleKey','scheduledFor'];
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==fields.length||!fields.every(key=>Object.hasOwn(body,key))||typeof body.scheduleKey!=='string'||typeof body.scheduledFor!=='string'||(raw.match(/"(?:mode|scheduleKey|scheduledFor)"\s*:/g)??[]).length!==fields.length)return reject(400,'RELAY_REQUEST_REJECTED');
   const candidates=readOnly?[...SCHEDULES,...ORIGINAL_SCHEDULES]:SCHEDULES;
   const schedule=candidates.find(row=>row.key===body.scheduleKey&&(readOnly?Date.parse(body.scheduledFor)>=Date.parse(row.anchor)&&(Date.parse(body.scheduledFor)-Date.parse(row.anchor))%(row.days*86400000)===0:body.scheduledFor===row.anchor)),due=Date.parse(body.scheduledFor),time=now();
   if(!schedule||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(body.scheduledFor)||!Number.isFinite(due)||new Date(due).toISOString()!==body.scheduledFor||due<Date.parse(schedule.anchor)||(due-Date.parse(schedule.anchor))%(schedule.days*86400000)!==0||due>time||(!readOnly&&time>=due+(schedule.window+5)*60000))return reject(400,'RUN_LIMIT_EXCEEDED');
   if(controller.signal.aborted)return reject(504,'RELAY_TIMEOUT');
   upstream=await withAbort(request(UPSTREAM+(readOnly?'/status':''),{method:'POST',redirect:'manual',signal:controller.signal,headers:{'Content-Type':'application/json','x-daily-sync-token':env.machineToken,'x-daily-sync-target':'phase08-full-app'},body:JSON.stringify({scheduleKey:body.scheduleKey,scheduledFor:body.scheduledFor})}),controller.signal);
   if(upstream.status>=300&&upstream.status<400)return reject(502,'RELAY_REDIRECT_REJECTED');
   const text=await boundedText(upstream.body,8192,controller.signal);const parsed=JSON.parse(text);
   if(upstream.status!==200&&upstream.status!==202){const status=[400,401,403,409,429,500,502,503,504].includes(upstream.status)?upstream.status:502;return reject(status,typeof parsed?.code==='string'&&codes.has(parsed.code)?parsed.code:'PROVIDER_UNAVAILABLE');}
   const last=new Date(due+9*3600000-86400000).toISOString().slice(0,10),first=new Date(Date.parse(last)-(schedule.days-1)*86400000).toISOString().slice(0,10);
   if(parsed?.scheduleKey!==body.scheduleKey||parsed.scheduledFor!==body.scheduledFor||parsed.fromDate!==first||parsed.toDate!==last||!statuses.has(parsed.status)||parsed.totalUnits!==schedule.days||!Number.isInteger(parsed.completedUnits)||parsed.completedUnits<0||parsed.completedUnits>schedule.days||(parsed.status==='SUCCEEDED'&&parsed.completedUnits!==schedule.days))return reject(502,'RELAY_RESPONSE_REJECTED');
   return response(upstream.status,{scheduleKey:body.scheduleKey,scheduledFor:body.scheduledFor,fromDate:first,toDate:last,status:parsed.status,completedUnits:parsed.completedUnits,totalUnits:schedule.days});
  }catch{return reject(controller.signal.aborted?504:502,controller.signal.aborted?'RELAY_TIMEOUT':'RELAY_REQUEST_REJECTED');}
  finally{if(timer!==undefined)clearTimer(timer);if(upstream?.body&&!upstream.body.locked)upstream.body.cancel().catch(()=>{});raw='';}
 };
}
