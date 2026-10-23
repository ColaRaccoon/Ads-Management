import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const VERSION='v23.0';
export const LIMITS=Object.freeze({requests:260,bytes:16777216,body:1048576,chunks:512,businessesPerToken:3,rows:100,pages:20,timeoutMs:20000,operationMs:900000});
const hash=x=>createHash('sha256').update(x).digest('hex');
const id=x=>typeof x==='string'&&/^\d{1,32}$/.test(x);
const accountId=x=>typeof x==='string'&&/^(?:act_)?\d{1,32}$/.test(x);
const shapePaths=new Set(['response','data','data.is_valid','data.scopes','data.granular_scopes','data.granular_scopes[].scope','data.granular_scopes[].target_ids','data.granular_scopes[].target_ids[]','id','data[].id','data[].permission','data[].status']);
function shape(field,value){const error=new Error('SHAPE');error.safeShape={path:shapePaths.has(field)?field:'response',type:value===null?'NULL':Array.isArray(value)?'ARRAY':({undefined:'UNDEFINED',string:'STRING',number:'NUMBER',boolean:'BOOLEAN',object:'OBJECT'})[typeof value]??'OTHER'};throw error;}
const permission=x=>typeof x==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(x);
const token=x=>typeof x==='string'&&/^[\x21-\x7e]{40,4096}$/.test(x);
const kinds=new Set(['debug','me','permissions','adaccounts','businesses','applications','apps','system_users','owned_apps']);
const codes=new Set([1,2,4,10,17,32,100,102,104,190,200,2500,613]);
export function endpoint(kind,target='me'){
  if(!kinds.has(kind))throw Error('ENDPOINT');
  if(['system_users','owned_apps'].includes(kind)){if(!id(target))throw Error('IDENTITY');}
  else if(target!=='me')throw Error('IDENTITY');
  const u=new URL(`https://graph.facebook.com/${VERSION}/${kind==='debug'?'debug_token':kind==='me'?'me':`${target}/${kind}`}`);
  if(kind!=='debug'){u.searchParams.set('fields',kind==='permissions'?'permission,status':'id');if(kind!=='me')u.searchParams.set('limit','100');}
  return u;
}
export function nextCursor(body){
  if(typeof body.paging?.next!=='string')return null;
  const cursor=body.paging?.cursors?.after;if(typeof cursor!=='string'||cursor.length<1||cursor.length>2048||!/^[-A-Za-z0-9_=]+$/.test(cursor))throw Error('CURSOR');return cursor;
}
export function project(kind,body){
  if(!kinds.has(kind)||!body||typeof body!=='object'||Array.isArray(body))shape('response',body);
  if(kind==='debug'){
    const d=body.data;if(!d||typeof d!=='object'||Array.isArray(d))shape('data',d);if(typeof d.is_valid!=='boolean')shape('data.is_valid',d.is_valid);
    const scopes=d.scopes===undefined?[]:d.scopes;if(!Array.isArray(scopes)||scopes.length>100||!scopes.every(permission))shape('data.scopes',d.scopes);
    const granular=d.granular_scopes===undefined?[]:d.granular_scopes;if(!Array.isArray(granular)||granular.length>100)shape('data.granular_scopes',d.granular_scopes);
    const targets=granular.map(g=>{if(!g||!permission(g.scope))shape('data.granular_scopes[].scope',g?.scope);if(g.target_ids===undefined)return {scope:g.scope,targetIdsPresent:false,targetHashes:null};if(!Array.isArray(g.target_ids)||g.target_ids.length>100)shape('data.granular_scopes[].target_ids',g.target_ids);if(!g.target_ids.every(id))shape('data.granular_scopes[].target_ids[]',g.target_ids.find(x=>!id(x)));return {scope:g.scope,targetIdsPresent:true,targetHashes:[...new Set(g.target_ids)].map(hash).sort()};});
    return {valid:d.is_valid,tokenType:['APP','USER','SYSTEM_USER','PAGE'].includes(d.type)?d.type:'OTHER_OR_ABSENT',appHash:id(d.app_id)?hash(d.app_id):null,expectedAppMatches:d.app_id==='4474691502806219',subjectHash:id(d.user_id)?hash(d.user_id):null,scopes:[...new Set(scopes)].sort(),granularScopes:targets,expiresAt:Number.isSafeInteger(d.expires_at)&&d.expires_at>=0?d.expires_at:null,dataAccessExpiresAt:Number.isSafeInteger(d.data_access_expires_at)&&d.data_access_expires_at>=0?d.data_access_expires_at:null};
  }
  if(kind==='me'){if(!id(body.id))shape('id',body.id);return {identityHash:hash(body.id)};}
  if(!Array.isArray(body.data)||body.data.length>100)shape('data',body.data);
  if(kind==='permissions')return {count:body.data.length,permissions:body.data.map(x=>{if(!permission(x?.permission))shape('data[].permission',x?.permission);if(!['granted','declined','expired'].includes(x.status))shape('data[].status',x.status);return {permission:x.permission,status:x.status};}),hasUnfollowedNext:typeof body.paging?.next==='string'};
  const valid=kind==='adaccounts'?accountId:id;if(!body.data.every(x=>x&&valid(x.id)))shape('data[].id',body.data.find(x=>!x||!valid(x.id))?.id);
  return {count:body.data.length,identityHashes:body.data.map(x=>hash(x.id)).sort(),...(kind==='adaccounts'?{accountIdentityHashes:body.data.map(x=>hash(x.id.replace(/^act_/,''))).sort(),expectedAccountVisible:body.data.some(x=>x.id.replace(/^act_/,'')==='2138525300002203')}:{}),hasUnfollowedNext:typeof body.paging?.next==='string'};
}
export async function runMetaRead(input,fetcher=fetch){
  if(!input||!token(input.mcp)||!token(input.inspector)||!input.equalities||Object.values(input.equalities).some(v=>v!==null&&typeof v!=='boolean'))throw Error('INPUT');
  let requests=0,bytes=0;const started=Date.now();const results=[];const businesses={MCP:new Set(),INSPECTOR:new Set()};
  const get=async(kind,label,target='me',cursor=null,page=1)=>{
    if(requests>=LIMITS.requests||bytes>=LIMITS.bytes||Date.now()-started>=LIMITS.operationMs)return {stop:true};const u=endpoint(kind,target);if(cursor)u.searchParams.set('after',cursor);
    if(kind==='debug')u.searchParams.set('input_token',label==='MCP'?input.mcp:input.inspector);
    requests++;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),LIMITS.timeoutMs);let response,reader;
    const entry={tokenClass:label,endpoint:kind,targetHash:target==='me'?null:hash(target),page};let projectionStage='REQUEST';
    try{
      response=await fetcher(u,{method:'GET',headers:{Authorization:`Bearer ${kind==='debug'?input.inspector:label==='MCP'?input.mcp:input.inspector}`},redirect:'error',signal:controller.signal});
      if(!Number.isInteger(response.status)||response.status<100||response.status>599)throw Error('HTTP');
      entry.httpStatus=response.status;
      const length=response.headers?.get('content-length');if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>LIMITS.body))throw Error('BODY_CAP');
      projectionStage='BODY_READ';reader=response.body?.getReader();if(!reader)throw Error('BODY');const parts=[];let n=0,c=0;
      while(true){const r=await reader.read();if(r.done)break;if(!(r.value instanceof Uint8Array))throw Error('BODY');c++;n+=r.value.length;bytes+=r.value.length;if(c>LIMITS.chunks||n>LIMITS.body||bytes>LIMITS.bytes)throw Error('BODY_CAP');parts.push(r.value);}
      projectionStage='JSON_PARSE';const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
      if(response.status!==200||raw.error){entry.status='DENIED_OR_PROVIDER_FAILURE';entry.providerCode=codes.has(raw.error?.code)?raw.error.code:null;results.push(entry);return;}
      projectionStage='PROJECTION';const p=project(kind,raw);projectionStage='CURSOR';const next=kind!=='debug'&&kind!=='me'?nextCursor(raw):null;entry.status='READ';entry.projection=p;results.push(entry);
      if(kind==='businesses')for(const x of raw.data)businesses[label].add(x.id);
      if(kind!=='debug'&&kind!=='me')return {cursor:next};
    }catch(error){entry.status='SAFE_FAILURE';entry.failure=controller.signal.aborted?'TIMEOUT':['BODY_CAP','REQUEST_CAP'].includes(error?.message)?error.message:error?.safeShape?'SHAPE_FAILURE':'TRANSPORT_OR_SHAPE';entry.failureStage=projectionStage;if(error?.safeShape&&shapePaths.has(error.safeShape.path)&&['NULL','ARRAY','UNDEFINED','STRING','NUMBER','BOOLEAN','OBJECT','OTHER'].includes(error.safeShape.type))entry.shape=error.safeShape;results.push(entry);}
    finally{clearTimeout(timer);try{await reader?.cancel();}catch{}try{if(!reader)await response?.body?.cancel();}catch{}}
  };
  const inventory=async(kind,label,target='me')=>{let cursor=null;const seen=new Set();for(let page=1;page<=LIMITS.pages;page++){const r=await get(kind,label,target,cursor,page);if(!r?.cursor)return;cursor=r.cursor;if(seen.has(cursor))return;seen.add(cursor);}};
  for(const label of ['MCP','INSPECTOR'])for(const kind of ['debug','me','permissions','adaccounts','businesses','applications','apps'])await inventory(kind,label);
  for(const label of ['MCP','INSPECTOR'])for(const business of [...businesses[label]].slice(0,LIMITS.businessesPerToken))for(const kind of ['system_users','owned_apps'])await inventory(kind,label,business);
  const receipt={kind:'META_CONSUMER_READONLY',observedAt:new Date().toISOString(),version:VERSION,requests,responseBytes:bytes,equalities:input.equalities,results,businessesSeen:{MCP:businesses.MCP.size,INSPECTOR:businesses.INSPECTOR.size},coverage:'FIXED_TWO_PROTECTED_TOKENS_MAX_20_PAGES_100_ROWS_MAX_THREE_BUSINESSES_EACH',allConsumersEnumerated:false,permissionDenialsAreNotAbsence:true,capsReached:{requests:requests>=LIMITS.requests,bytes:bytes>=LIMITS.bytes,deadline:Date.now()-started>=LIMITS.operationMs,businesses:businesses.MCP.size>3||businesses.INSPECTOR.size>3},tokenIssuance:0,tokenRefresh:0,tokenRevocation:0,remoteWrites:0,rawValuesReturned:0};
  const wire=JSON.stringify(receipt);for(const secret of [input.mcp,input.inspector])if(wire.includes(secret))throw Error('OUTPUT_GUARD');if(wire.length>262144)throw Error('OUTPUT_GUARD');return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let wire='';try{if(process.env.META_CONSUMER_READONLY_PARENT!=='20261021-ROOT')throw Error('PARENT');for await(const chunk of process.stdin){wire+=chunk.toString('utf8');if(Buffer.byteLength(wire)>32768)throw Error('INPUT_CAP');}const result=await runMetaRead(JSON.parse(wire));process.stdout.write(JSON.stringify(result));}catch{process.stdout.write(JSON.stringify({kind:'META_CONSUMER_READONLY',status:'SAFE_REJECTION',rawValuesReturned:0}));process.exitCode=1;}finally{wire='';}
}
