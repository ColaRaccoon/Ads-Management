import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TARGET,renewStorage} from './core.mjs';
const now=1800000000;
function fixture(){
 const original={role:'storage_app',iss:TARGET.origin+'/auth/v1',aud:'authenticated',sub:'fixture-subject',iat:now-4*86400,exp:now+2*86400};
 const vars={SUPABASE_URL:TARGET.origin,SUPABASE_STORAGE_BUCKET:TARGET.bucket,SUPABASE_DATABASE_RUNTIME_USER:'meta_ads_prod_runtime',SUPABASE_STORAGE_ACCESS_TOKEN:'old',SUPABASE_STORAGE_TOKEN_SUBJECT:original.sub};
 let writes=0,reads=0,issued;
 return {vars,original,writes:()=>writes,options:{now,readiness:async()=>{},verify:async t=>t==='old'?original:issued,issue:async(sub,iat,exp)=>{issued={...original,sub,iat,exp};return 'new'},probe:async()=>{},api:async(op)=>{if(op==='read'){reads++;return {...vars}}writes++;return true}}};
}
test('renews only due scoped token, probes and requests deployment',async()=>{const f=fixture();const r=await renewStorage(f.options);assert.equal(r.state,'DEPLOYMENT_REQUESTED');assert.equal(f.writes(),1);assert.equal(r.readinessVerified,false)});
test('keeps healthy token without mutation',async()=>{const f=fixture();f.original.iat=now;f.original.exp=now+6*86400;assert.equal((await renewStorage(f.options)).state,'HEALTHY');assert.equal(f.writes(),0)});

test('new token in variables cannot hide failed app deployment',async()=>{const f=fixture();f.original.iat=now;f.original.exp=now+6*86400;f.options.readiness=async()=>{throw Error('DEPLOYMENT_NOT_APPLIED')};await assert.rejects(renewStorage(f.options));assert.equal(f.writes(),0)});
test('check-only mode never renews a due or expired token',async()=>{const f=fixture();f.options.checkOnly=true;assert.equal((await renewStorage(f.options)).state,'HEALTHY');f.original.exp=now-1;await assert.rejects(renewStorage(f.options));assert.equal(f.writes(),0)});
test('authenticated manual first rotation can renew early',async()=>{const f=fixture();f.options.force=true;f.original.iat=now;f.original.exp=now+6*86400;assert.equal((await renewStorage(f.options)).state,'DEPLOYMENT_REQUESTED');assert.equal(f.writes(),1)});
test('rejects wrong target and elevated token role',async()=>{for(const mode of ['target','role']){const f=fixture();if(mode==='target')f.vars.SUPABASE_URL='https://wrong.invalid';else f.original.role='service_role';await assert.rejects(renewStorage(f.options));assert.equal(f.writes(),0)}});
test('provider probe failure prevents variable update',async()=>{const f=fixture();f.options.probe=async()=>{throw Error('offline')};await assert.rejects(renewStorage(f.options));assert.equal(f.writes(),0)});
test('preserves concurrent rotation',async()=>{const f=fixture();f.options.probe=async()=>{f.vars.SUPABASE_STORAGE_ACCESS_TOKEN='other'};assert.equal((await renewStorage(f.options)).state,'CONCURRENT_ROTATION_PRESERVED');assert.equal(f.writes(),0)});
test('ambiguous update is never repeated inside invocation',async()=>{const f=fixture();const api=f.options.api;f.options.api=async(op)=>{const r=await api(op);if(op!=='read')throw Error('timeout');return r};await assert.rejects(renewStorage(f.options));assert.equal(f.writes(),1)});
