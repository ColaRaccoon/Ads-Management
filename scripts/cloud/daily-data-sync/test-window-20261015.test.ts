import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceProvider } from '@prisma/client';
import { occurrence } from '../../../apps/api/src/daily-sync/scheduled-occurrence';
const env={SUPABASE_URL:'https://ehnfrrmbkvlsbpvqcvkr.supabase.co',SUPABASE_DATABASE_PROJECT_REF:'ehnfrrmbkvlsbpvqcvkr',SUPABASE_DATABASE_SCHEMA:'phase08_meta_ads',SUPABASE_DATABASE_RUNTIME_USER:'phase08_runtime',DEPLOYMENT_ENVIRONMENT_ID:'phase08-daily-data-sync-08',RUNTIME_API_TARGET_ID:'phase08-full-app'};
const rows=[['phase08-cafe24','0c35defe-45fc-4a54-bc79-704df7bca5b1',SourceProvider.CAFE24,'2026-10-15T01:00:00.000Z',110],['phase08-google','b9ebee4b-5d4e-4eae-92b9-9facfbf3c900',SourceProvider.GOOGLE,'2026-10-15T01:01:00.000Z',90],['phase08-meta','1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',SourceProvider.META,'2026-10-15T01:02:00.000Z',90]] as const;
test('approved October15 isolated real-clock window retains original completed dates and denies all identity/scope/date mutations',()=>{
 const saved={...process.env};Object.assign(process.env,env);
 try {for(const [key,connectionId,provider,anchorAt,windowMinutes] of rows){
  const def={key,connectionId,anchorAt,windowMinutes},now=new Date('2026-10-15T01:03:00.000Z');
  const result=occurrence(def,provider,'Asia/Seoul',anchorAt,now);
  assert.equal(result.toDate,'2026-10-14');assert.equal(result.fromDate,provider==='CAFE24'?'2026-10-14':'2026-10-08');
  assert.throws(()=>occurrence(def,provider,'Asia/Seoul',anchorAt,new Date('2026-10-15T00:59:59Z')));
  for(const field of Object.keys(env)){process.env[field]='FOREIGN';assert.throws(()=>occurrence(def,provider,'Asia/Seoul',anchorAt,now));Object.assign(process.env,env);}
  for(const changed of [{...def,key:'foreign-key'},{...def,connectionId:'00000000-0000-4000-8000-000000000000'},{...def,windowMinutes:windowMinutes-1}])assert.throws(()=>occurrence(changed,provider,'Asia/Seoul',anchorAt,now));
  const next=new Date(Date.parse(anchorAt)+(provider==='CAFE24'?1:7)*86400000).toISOString();assert.throws(()=>occurrence(def,provider,'Asia/Seoul',next,new Date(next)));
 }
 }finally{for(const field of Object.keys(process.env))if(!(field in saved))delete process.env[field];Object.assign(process.env,saved);}
});
