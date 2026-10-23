import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayHandler,SCHEDULES,ORIGINAL_SCHEDULES,RELAY_TIMEOUT_MS} from './fixtures/relay-20261015-v2.mjs';
import {relayTransportPatchSql,RELAY_URL} from './relay-transport-patch.mjs';
const env={basicPassword:Buffer.alloc(32,5).toString('base64'),machineToken:Buffer.alloc(32,7).toString('base64')};
const auth='Basic '+btoa('phase08-scheduler:'+env.basicPassword);
const req=(body,changes={})=>new Request(RELAY_URL,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(body),...changes});
const body=(row=SCHEDULES[0])=>({scheduleKey:row.key,scheduledFor:row.anchor});
const summary=(row=SCHEDULES[0],extras={})=>{const last=new Date(Date.parse(row.anchor)+9*3600000-86400000).toISOString().slice(0,10);return {...body(row),fromDate:new Date(Date.parse(last)-(row.days-1)*86400000).toISOString().slice(0,10),toDate:last,status:'SUCCEEDED',completedUnits:row.days,totalUnits:row.days,...extras};};
const at=()=>Date.parse(SCHEDULES[0].anchor)+3*60000;
test('all three exact scopes forward only fixed origin/manual machine headers and return projected date/count summary',async()=>{
 for(const row of SCHEDULES){let calls=0;const handler=createRelayHandler({env,now:at,request:async(url,options)=>{calls++;assert.equal(url,'https://phase08-daily-data-sync-production.up.railway.app/backend-api/internal/daily-sync');assert.equal(options.redirect,'manual');assert.equal(options.headers['x-daily-sync-token'],env.machineToken);assert(!('Authorization'in options.headers));assert.deepEqual(JSON.parse(options.body),body(row));return Response.json(summary(row,{id:'SYNTHETIC_PRIVATE',unknown:env.machineToken}));}});
 const response=await handler(req(body(row)));assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');const text=await response.text();assert(!text.includes('SYNTHETIC_PRIVATE'));assert(!text.includes(env.machineToken));assert.equal(calls,1);assert.equal(JSON.parse(text).totalUnits,row.days);}
});
test('auth/strict JSON/method/scope/dates/future and expired ranges reject before upstream',async()=>{
 let calls=0;const handler=createRelayHandler({env,now:at,request:async()=>{calls++;throw Error('must not call');}});
 for(const request of [req(body(),{headers:{'Content-Type':'application/json'}}),req(body(),{headers:{Authorization:'Basic wrong','Content-Type':'application/json'}}),req({...body(),fromDate:'2026-10-01'}),req({...body(),scheduleKey:'unknown'}),req({...body(),scheduledFor:'2026-10-15T17:00:00.000Z'}),req(body(),{method:'PUT'}),req(body(),{body:'{"scheduleKey":"phase08-cafe24","scheduleKey":"phase08-cafe24","scheduledFor":"2026-10-14T17:00:00.000Z"}'})])assert([400,403].includes((await handler(request)).status));
 const expired=createRelayHandler({env,now:()=>at()+200*60000,request:async()=>{calls++;}});assert.equal((await expired(req(body()))).status,400);assert.equal(calls,0);
});
test('every upstream redirect is fixed502/no Location/no redirect following; no raw body/error escaped',async()=>{
 for(const status of [301,302,303,307,308]){let calls=0;const handler=createRelayHandler({env,now:at,request:async()=>{calls++;return new Response('SYNTHETIC_PRIVATE',{status,headers:{Location:'https://evil.invalid'}});}});const response=await handler(req(body()));assert.equal(response.status,502);assert.equal(response.headers.get('Location'),null);assert(!((await response.text()).includes('SYNTHETIC_PRIVATE')));assert.equal(calls,1);}
});
test('untrusted never-finishing stream cancellation cannot hold a rejected redirect response open',async()=>{
 const stream=new ReadableStream({cancel:()=>new Promise(()=>{})});
 const handler=createRelayHandler({env,now:at,request:async()=>new Response(stream,{status:307,headers:{Location:'https://evil.invalid'}})});
 const result=await Promise.race([handler(req(body())),new Promise(resolve=>setTimeout(()=>resolve('HUNG_CANCEL'),100))]);
 assert.notEqual(result,'HUNG_CANCEL');assert.equal(result.status,502);
});
test('response bounds/range mismatch/unsafe error strings reject and exact LEASE_LOST409 passes safe scalar',async()=>{
 for(const response of [new Response('x'.repeat(8193)),Response.json(summary(SCHEDULES[0],{fromDate:'2026-10-13'})),Response.json({code:'SYNTHETIC_PRIVATE'},{status:500})]){const result=await createRelayHandler({env,now:at,request:async()=>response})(req(body()));assert([500,502].includes(result.status));assert(!(await result.text()).includes('SYNTHETIC_PRIVATE'));}
 const result=await createRelayHandler({env,now:at,request:async()=>Response.json({code:'LEASE_LOST',message:'SYNTHETIC_PRIVATE'},{status:409})})(req(body()));assert.equal(result.status,409);assert.deepEqual(await result.json(),{code:'LEASE_LOST'});
});
test('75s deadline abort fence bounds hung upstream even when mock ignores signal; configuration secrets distinct',async()=>{
 assert.equal(RELAY_TIMEOUT_MS,75000);let abort;
 const handler=createRelayHandler({env,now:at,setTimer:fn=>{abort=fn;return 1;},clearTimer:()=>{},request:()=>{abort();return new Promise(()=>{});}});
 const response=await handler(req(body()));assert.equal(response.status,504);assert.deepEqual(await response.json(),{code:'RELAY_TIMEOUT'});
 const bad=createRelayHandler({env:{...env,basicPassword:env.machineToken},request:()=>{throw Error('forbidden');}});assert.equal((await bad(req(body()))).status,503);
});
test('explicit aligned status is read-only fixed path after deadline; step/noncadence ranges and malformed bodies still reject',async()=>{
 let calls=0;const handler=createRelayHandler({env,now:()=>at()+24*3600000,request:async(url,options)=>{calls++;assert(url.endsWith('/daily-sync/status'));assert.deepEqual(JSON.parse(options.body),body());return Response.json(summary(SCHEDULES[0],{status:'EXPIRED',completedUnits:0}));}});
 assert.equal((await handler(req({...body(),mode:'status'}))).status,200);assert.equal(calls,1);
 for(const input of [req(body()),req({...body(),mode:'execute'}),req({...body(),mode:'status',scheduledFor:'2026-10-15T18:00:00.000Z'}),req(body(),{body:'{invalid'}),req(body(),{body:'x'.repeat(1025)})])assert.equal((await handler(input)).status,400);
 assert.equal(calls,1);
});
test('guarded SQL function-only patch removes unsupported option, uses built-in Basic, resets and preserves schedules/attempts/jobs',async()=>{
 const sql=await relayTransportPatchSql({expectedProsrcMd5:'a'.repeat(32),reviewedRelaySourceSha256:'b'.repeat(64)});
 assert.match(sql,/CURLOPT_USERPWD/);assert.doesNotMatch(sql,/CURLOPT_FOLLOWLOCATION|http_header\('x-daily-sync-token'/);assert(sql.includes(RELAY_URL));assert.match(sql,/UNSAFE_LOGGING/);assert.match(sql,/WHEN query_canceled THEN\s+secret:=NULL; PERFORM extensions\.http_reset_curlopt\(\);\s+RAISE;/);assert.match(sql,/md5\(p.prosrc\)/);assert.equal((sql.match(/http_reset_curlopt\(\)/g)||[]).length,4);
 assert.doesNotMatch(sql,/UPDATE daily_data_sync_ops\.schedules|UPDATE daily_data_sync_ops\.settings|DELETE FROM|cron\.schedule\(|TRUNCATE|INSERT INTO vault/);assert.match(sql,/INSERT INTO daily_data_sync_ops\.attempts/);
 await assert.rejects(relayTransportPatchSql({expectedProsrcMd5:'wrong',reviewedRelaySourceSha256:'b'.repeat(64)}));
});

test('October15 normal relay permits exact test anchors only; original closed status remains read-only',async()=>{
 let calls=0;const handler=createRelayHandler({env,now:at,request:async(url,options)=>{calls++;assert(url.endsWith('/status'));const b=JSON.parse(options.body);const row=ORIGINAL_SCHEDULES.find(r=>r.key===b.scheduleKey);const out=summary(row,{status:'EXPIRED',completedUnits:0});return Response.json(out);}});
 for(const row of ORIGINAL_SCHEDULES){assert.equal((await handler(req(body(row)))).status,400);assert.equal((await handler(req({...body(row),mode:'status'}))).status,200);}
 for(const row of SCHEDULES){const next=new Date(Date.parse(row.anchor)+row.days*86400000).toISOString();assert.equal((await handler(req({...body(row),scheduledFor:next}))).status,400);}
 assert.equal(calls,3);
});
