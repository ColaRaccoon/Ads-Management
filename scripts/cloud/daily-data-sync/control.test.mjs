import test from 'node:test';
import assert from 'node:assert/strict';
import { control } from './control.mjs';
const config={key:'abc',connectionId:'00000000-0000-4000-8000-000000000001',provider:'GOOGLE',timeZone:'Asia/Seoul',anchorAt:'2026-10-12T17:05:00.000Z',windowMinutes:90,targetId:'staging-08-target'};
function fake(overrides={}) {
 const calls=[];
 const client={calls,
  $executeRawUnsafe:async(sql,...args)=>{calls.push({sql,args});return 1;},
  $queryRawUnsafe:async(sql,...args)=>{
   calls.push({sql,args});
   if(sql.includes('target_id,stopped'))return [{target_id:config.targetId,stopped:overrides.stopped??true}];
   if(sql.includes('SELECT paused'))return [{paused:overrides.paused??true}];
   if(sql.includes('attempts WHERE'))return [{count:overrides.attempts??0}];
   if(sql.includes('vault.secrets'))return [{count:overrides.secrets??1}];
   if(sql.includes('SELECT key FROM'))return [{key:config.key}];
   if(sql.includes('cron.schedule'))return [{id:3n}];
   if(sql.includes('SELECT jobid'))return [{jobid:1n}];
   return [];
  },
  $transaction:async cb=>cb(client)
 };return client;
}
test('missing/invalid deployment proof blocks install/configure/resume/enable before any DB mutation',async()=>{
 for(const mode of ['install','configure','resume','enable']) {
  const db=fake();await assert.rejects(control(db,mode,config),/STAGING_APP_NOT_PROVISIONED|STAGING_DEPLOYMENT_EVIDENCE_REJECTED/);
  assert.equal(db.calls.length,0);
 }
});
test('read-only management status remains available while activation is blocked',async()=>{
 const db=fake();await control(db,'status');
 assert.equal(db.calls.length,3);
 assert(db.calls.every(c=>c.sql.startsWith('SELECT ')));
});
test('invalid stop target cannot alter unrelated account jobs',async()=>{
 const db=fake();await assert.rejects(control(db,'pause',{key:"abc';SELECT"}),/INVALID_KEY/);
 assert.equal(db.calls.length,0);
});
test('kill changes only management switch, pause only exact account jobs',async()=>{
 const db=fake();assert.equal((await control(db,'kill')).state,'KILLED');
 assert.equal(db.calls.length,1);assert.equal(db.calls[0].args[0],true);
 await control(db,'pause',{key:'abc'});
 assert(db.calls.some(c=>c.sql.includes('alter_job')&&c.args[1]===false));
 const find=db.calls.find(c=>c.sql.includes('SELECT jobid'));
 const expression=new RegExp(find.args[1]);
 assert(expression.test('daily-data-sync-08-abc-2'));
 assert(!expression.test('daily-data-sync-08-abc-def-2'));
 assert(!expression.test('storage-renewal-daily'));
});
