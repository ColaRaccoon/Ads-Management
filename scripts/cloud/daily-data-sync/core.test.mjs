import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertTarget, assertSchedule, assertResponse, occurrence, jobPlan } from './core.mjs';
const config={key:'cafe-test',connectionId:'00000000-0000-4000-8000-000000000001',provider:'CAFE24',timeZone:'Asia/Seoul',anchorAt:'2026-10-12T17:00:00.000Z',windowMinutes:90};
test('staging exact host, postgres role, session port and verified TLS only',()=>{
 assertTarget('postgresql://postgres:dummy@db.ehnfrrmbkvlsbpvqcvkr.supabase.co:5432/postgres?sslmode=verify-full');
 assertTarget('postgresql://postgres.ehnfrrmbkvlsbpvqcvkr:dummy@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=verify-full');
 for(const url of ['postgresql://postgres:dummy@db.iygjmosbelbosfxidqxv.supabase.co/postgres?sslmode=verify-full','postgresql://postgres:dummy@127.0.0.1/postgres?sslmode=verify-full','postgresql://postgres:dummy@db.ehnfrrmbkvlsbpvqcvkr.supabase.co:6543/postgres?sslmode=verify-full','postgresql://postgres:dummy@db.ehnfrrmbkvlsbpvqcvkr.supabase.co/postgres?sslmode=require'])assert.throws(()=>assertTarget(url));
});
test('Cafe24 daily occurrence remains fixed across retries',()=>{
 assert.equal(occurrence(config,Date.parse('2026-10-12T16:59:59Z')),null);
 assert.equal(occurrence(config,Date.parse('2026-10-12T17:20Z')).scheduledFor,config.anchorAt);
 assert.equal(occurrence(config,Date.parse('2026-10-13T17:00Z')).scheduledFor,'2026-10-13T17:00:00.000Z');
});
test('weekly next occurrence excludes previous missed week',()=>{
 const weekly={...config,provider:'META',windowMinutes:100};
 assert.equal(assertSchedule(weekly).cadenceDays,7);
 assert.equal(occurrence(weekly,Date.parse('2026-10-26T17:05Z')).scheduledFor,'2026-10-26T17:00:00.000Z');
});
test('02:00 Cafe24 and 04:00 conflict guard',()=>{
 assert.throws(()=>assertSchedule({...config,windowMinutes:30}));
 assert.throws(()=>assertSchedule({...config,anchorAt:'2026-10-12T17:01:00.000Z'}));
 assert.throws(()=>assertSchedule({...config,provider:'GOOGLE',windowMinutes:120,anchorAt:'2026-10-12T17:05:00.000Z'}));
 assert.throws(()=>assertSchedule({...config,provider:'META',windowMinutes:116}));
 assert.equal(assertSchedule({...config,provider:'META',windowMinutes:115}).windowMinutes,115);
 assert.throws(()=>assertSchedule({...config,timeZone:'UTC'}));
 assert.throws(()=>assertSchedule({...config,provider:'GOOGLE',windowMinutes:30}));
});
test('HTTP response range, membership and completed-unit count bind success',()=>{
 const expected={...config,scheduledFor:config.anchorAt};
 const body={scheduleKey:config.key,scheduledFor:config.anchorAt,status:'SUCCEEDED',completedUnits:1,totalUnits:1,fromDate:'2026-10-12',toDate:'2026-10-12'};
 assert.equal(assertResponse(body,expected).status,'SUCCEEDED');
 for(const patch of [{completedUnits:0},{scheduleKey:'foreign'},{toDate:'2026-10-13'},{fromDate:'2026-10-10',toDate:'2026-10-10'},{totalUnits:7},{status:'HEALTHY'}])assert.throws(()=>assertResponse({...body,...patch},expected));
 assert.equal(assertResponse({...body,status:'PARTIAL',completedUnits:0},expected).status,'PARTIAL');
});
test('weekly seven dated units and incomplete 202 are not success',()=>{
 const expected={...config,provider:'GOOGLE',scheduledFor:config.anchorAt};
 const body={scheduleKey:config.key,scheduledFor:config.anchorAt,status:'PARTIAL',completedUnits:1,totalUnits:7,fromDate:'2026-10-06',toDate:'2026-10-12'};
 assert.equal(assertResponse(body,expected).status,'PARTIAL');
 assert.throws(()=>assertResponse({...body,status:'SUCCEEDED'},expected));
 assertResponse({...body,status:'SUCCEEDED',completedUnits:7},expected);
});
test('unique account jobs, bounded resumes and audit stop before storage',()=>{
 const jobs=jobPlan({...config,provider:'META',windowMinutes:100});
 assert.equal(new Set(jobs.map(j=>j.name)).size,jobs.length);
 assert.equal(jobs.length,21);
 assert.equal(jobs.at(-1).cron,'43 18 * * *');
 assert(jobs.every(j=>!j.command.includes('storage_renewal')));
 const cafe=jobPlan({...config,windowMinutes:90});
 assert.equal(cafe.length,91);
 assert.equal(cafe.at(-1).cron,'33 18 * * *');
});
test('SQL persists only safe diagnostics and isolates management/Vault',async()=>{
 const sql=await readFile(new URL('./install.sql',import.meta.url),'utf8');
 assert.match(sql,/SECURITY DEFINER SET search_path=''/);
 assert.match(sql,/REVOKE ALL ON ALL FUNCTIONS.*FROM PUBLIC/);
 assert.match(sql,/vault\.decrypted_secrets WHERE name='daily_data_sync_08_machine'/);
 assert.doesNotMatch(sql,/pg_net\./);
 assert.doesNotMatch(sql,/RAISE EXCEPTION.*SQLERRM/);
 assert.match(sql,/EXCEPTION WHEN OTHERS THEN[\s\S]*INSERT INTO daily_data_sync_ops.attempts/);
 assert.match(sql,/ELSIF res.status=409 THEN[\s\S]*jsonb_typeof\(body->'code'\)='string' AND body->>'code'='LEASE_LOST'[\s\S]*state:='DELAYED';code:='APP_LEASE_BUSY'/);
});
