import 'reflect-metadata';
import test from 'node:test';import assert from 'node:assert/strict';
import {SourceProvider} from '@prisma/client';
import {occurrence} from '../../../apps/api/src/daily-sync/scheduled-occurrence';
const env={SUPABASE_URL:'https://ehnfrrmbkvlsbpvqcvkr.supabase.co',SUPABASE_DATABASE_PROJECT_REF:'ehnfrrmbkvlsbpvqcvkr',SUPABASE_DATABASE_SCHEMA:'phase08_meta_ads',SUPABASE_DATABASE_RUNTIME_USER:'phase08_runtime',DEPLOYMENT_ENVIRONMENT_ID:'phase08-daily-data-sync-08',RUNTIME_API_TARGET_ID:'phase08-full-app'};
test('three explicitly approved actual-clock occurrences preserve completed dates and original budgets; foreign scopes and future repeats reject',()=>{
 const before={...process.env};Object.assign(process.env,env);
 try{for(const [provider,id,at,window]of [
 ['META','1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6','2026-10-15T06:00:00.000Z',35],
 ['CAFE24','0c35defe-45fc-4a54-bc79-704df7bca5b1','2026-10-15T06:40:00.000Z',110],
 ['META','1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6','2026-10-15T07:00:00.000Z',90]
 ]as const){const d={key:'phase08-'+provider.toLowerCase(),connectionId:id,anchorAt:at,windowMinutes:window},p=SourceProvider[provider];const r=occurrence(d,p,'Asia/Seoul',at,new Date(at));assert.equal(r.toDate,'2026-10-14');assert.equal(r.fromDate,provider==='CAFE24'?'2026-10-14':'2026-10-08');assert.equal(r.deadlineAt.getTime()-Date.parse(at),window*60000);
 for(const bad of [{...d,key:d.key+'x'},{...d,windowMinutes:window+1},{...d,connectionId:'11111111-1111-4111-8111-111111111111'}])assert.throws(()=>occurrence(bad,p,'Asia/Seoul',at,new Date(at)));
 assert.throws(()=>occurrence(d,p,'Asia/Seoul',at,new Date(Date.parse(at)-1)));
 const next=new Date(Date.parse(at)+(provider==='CAFE24'?1:7)*86400000).toISOString();assert.throws(()=>occurrence(d,p,'Asia/Seoul',next,new Date(next)));
 process.env.SUPABASE_DATABASE_SCHEMA='meta_ads';assert.throws(()=>occurrence(d,p,'Asia/Seoul',at,new Date(at)));Object.assign(process.env,env);
 }}finally{for(const key of Object.keys(env))if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
});
