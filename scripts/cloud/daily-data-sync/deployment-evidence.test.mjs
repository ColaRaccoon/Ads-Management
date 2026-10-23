import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {ISOLATED_IDENTITY,FIXED_CONNECTIONS,validateDeploymentEvidence,assertReviewedDeployment} from './deployment-evidence.mjs';
import {buildManagementBatch,validateIsolatedSchedules,renderManagementBatch,effectiveScheduleRange} from './management-batch.mjs';
const now=Date.parse('2026-10-14T01:00:00.000Z');
const pair=generateKeyPairSync('ed25519');
const pins={sourceSha:'a'.repeat(64),deploymentId:'abcddcba-1234-4321-8123-123456789abc',publicKeyB64:pair.publicKey.export({format:'der',type:'spki'}).toString('base64')};
const definitions=FIXED_CONNECTIONS.map((row,i)=>({key:`phase08-${row.provider.toLowerCase()}`,connectionId:row.connectionId,provider:row.provider,timeZone:row.timeZone,anchorAt:`2026-10-14T17:0${i}:00.000Z`,windowMinutes:row.provider==='CAFE24'?90:35,targetId:ISOLATED_IDENTITY.targetId}));
function payload() {
  return {kind:'PHASE08_ROOT_REVIEWED_DEPLOYMENT_V1',identity:{...ISOLATED_IDENTITY},sourceSha:pins.sourceSha,deploymentId:pins.deploymentId,deploymentStatus:'SUCCESS',observedAt:new Date(now).toISOString(),expiresAt:new Date(now+600000).toISOString(),graphObservedAt:new Date(now-10000).toISOString(),readyObservedAt:new Date(now-5000).toISOString(),databaseObservedAt:new Date(now-15000).toISOString(),database:{database:'postgres',privilegedRole:'postgres',runtimeRole:'phase08_runtime',schema:'phase08_meta_ads',tableCount:68,forceRlsCount:68,cronTimezone:'GMT',storageRenewalOpsPresent:false},connections:FIXED_CONNECTIONS.map(row=>{const kinds=row.provider==='CAFE24'?['CAFE24_ORDER']:row.provider==='GOOGLE'?['GOOGLE_CAMPAIGN']:['META_AD','META_ADSET'];return {...row,enabled:true,accessState:'READY',policyKinds:kinds,policyFromDates:Object.fromEntries(kinds.map(kind=>[kind,row.provider==='CAFE24'?'2026-10-14':'2026-10-07']))};}),appSchedules:definitions.map(({key,connectionId,anchorAt,windowMinutes})=>({key,connectionId,anchorAt,windowMinutes})),managementSchedules:[],featureEnabled:true,scheduleEnabled:false};
}
const envelope=p=>({payload:p,signatureB64:sign(null,Buffer.from(JSON.stringify(p)),pair.privateKey).toString('base64')});
test('fresh root-reviewed Ed25519 evidence binds every isolated resource/connection/policy and returns an independent value',()=>{
  const proof=envelope(payload());const checked=validateDeploymentEvidence(proof,pins,now);assert.deepEqual(checked,proof.payload);
  checked.identity.origin='https://synthetic.invalid';assert.equal(proof.payload.identity.origin,ISOLATED_IDENTITY.origin);
});
test('invalid signature, foreign target, stale observations, runtime/RLS mismatch and disabled connection fail closed',()=>{
  for(const mode of ['signature','origin','source','expiry','future','old-graph','role','rls','disabled','policy','extra']) {
    const p=payload();if(mode==='origin')p.identity.origin='https://patimagroup-work.com';if(mode==='source')p.sourceSha='b'.repeat(64);
    if(mode==='expiry')p.expiresAt=new Date(now-1).toISOString();if(mode==='future')p.observedAt=new Date(now+60000).toISOString();if(mode==='old-graph')p.graphObservedAt=new Date(now-360000).toISOString();
    if(mode==='role')p.database.privilegedRole='readonly_user';if(mode==='rls')p.database.forceRlsCount=67;if(mode==='disabled')p.connections[0].enabled=false;if(mode==='policy')p.connections[0].policyFromDates={};if(mode==='extra')p.identity.secret='SYNTHETIC_PRIVATE';
    const e=envelope(p);if(mode==='signature')e.signatureB64=Buffer.alloc(64).toString('base64');assert.throws(()=>validateDeploymentEvidence(e,pins,now));
  }
});
test('empty pins or invalid signed proof prohibit every mutable batch but stop/status need no signing material',async()=>{
  assert.throws(()=>assertReviewedDeployment(envelope(payload())),/STAGING_APP_NOT_PROVISIONED|STAGING_DEPLOYMENT_EVIDENCE_REJECTED/);
  for(const mode of ['install','configure','resume','enable'])await assert.rejects(buildManagementBatch(mode,definitions,envelope(payload())),/STAGING_APP_NOT_PROVISIONED|STAGING_DEPLOYMENT_EVIDENCE_REJECTED/);
  const kill=await buildManagementBatch('kill');assert.match(kill,/stopped=true/);assert.doesNotMatch(kill,/FORCERLS|relforcerowsecurity/);
  assert.match(await buildManagementBatch('pause',[{key:'phase08-cafe24'}]),/active:=false/);
  assert.match(await buildManagementBatch('status'),/^SELECT /);
});
test('fresh installation initializes exactly the stopped singleton inside the same atomic batch',()=>{
  const sql=renderManagementBatch('install',[],'SELECT 1;');
  assert.match(sql,/INSERT INTO daily_data_sync_ops.settings\(singleton,stopped,target_id,origin\) VALUES\(true,true,'phase08-full-app'/);
  assert.match(sql,/ON CONFLICT\(singleton\) DO NOTHING/);assert.match(sql,/INSTALL_REQUIRES_INERT_BASELINE/);
  assert.equal((sql.match(/^BEGIN;/gm)??[]).length,1);assert.equal((sql.match(/^COMMIT;/gm)??[]).length,1);
});
test('three fixed connections/app definitions/policy dates are mandatory; configure renders one atomic paused batch and no Vault secret literals',()=>{
  const p=payload(),checked=validateIsolatedSchedules(definitions,p);
  const sql=renderManagementBatch('configure',checked);assert.match(sql,/^BEGIN;/);assert.match(sql,/COMMIT;$/);
  assert.equal((sql.match(/cron\.schedule\(/g)||[]).length,107);assert.equal((sql.match(/active:=false/g)||[]).length,107);
  assert.doesNotMatch(sql,/create_secret|update_secret|decrypted_secrets|pg_net/);
  assert.throws(()=>validateIsolatedSchedules([{...definitions[0],connectionId:definitions[1].connectionId},...definitions.slice(1)],p));
  assert.throws(()=>validateIsolatedSchedules(definitions.slice(0,2),p));
  const changed=payload();changed.appSchedules[0].windowMinutes=60;assert.throws(()=>validateIsolatedSchedules(definitions,changed),/APP_SCHEDULE_MISMATCH/);
  const future=payload();future.connections[2].policyFromDates.META_AD='2026-10-14';assert.throws(()=>validateIsolatedSchedules(definitions,future),/ANCHOR_BEFORE_POLICY/);
});
test('activation after a closed window validates the next cadence only, retaining the original anchor and never collecting a missed date',()=>{
  const cafe=definitions[0],google=definitions[1];
  assert.deepEqual(effectiveScheduleRange(cafe,Date.parse('2026-10-15T02:00:00Z')),{fromDate:'2026-10-15',toDate:'2026-10-15'});
  assert.deepEqual(effectiveScheduleRange(google,Date.parse('2026-10-15T02:00:00Z')),{fromDate:'2026-10-15',toDate:'2026-10-21'});
  assert.equal(cafe.anchorAt,'2026-10-14T17:00:00.000Z');
  const sql=renderManagementBatch('resume',definitions);assert.match(sql,/first_day:=last_day-6/);assert.match(sql,/instant>=due\+35\*interval/);
  assert.throws(()=>renderManagementBatch('configure',[{...definitions[0],connectionId:definitions[1].connectionId},...definitions.slice(1)]));
});
