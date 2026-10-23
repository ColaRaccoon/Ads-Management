import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv,hkdfSync } from 'node:crypto';
import { prepareIncidentCryptoTransform } from './incident-crypto-transform.mjs';
import { syntheticIncidentCryptoInput } from './incident-crypto-fixtures.mjs';
import { credentialKey } from '../../../apps/api/src/daily-sync/credential-vault.ts';
import { cafe24ObservationKey } from '../../../apps/api/src/daily-sync/cafe24-observed-revision.ts';

test('prepare reencrypts exactly two synthetic token rows without tokens/keys in SQL',()=>{
 const{input,plaintexts}=syntheticIncidentCryptoInput(),result=prepareIncidentCryptoTransform(input);
 assert.equal(result.safeSummary.credentialRowsReencrypted,2);assert.equal(result.safeSummary.checkpointRowsReencrypted,2);
 assert.ok(Object.values(input.oldKeys).every(k=>!result.mutationSql.includes(k)));
 assert.ok(Object.values(input.newKeys).every(k=>!result.mutationSql.includes(k)));
 assert.ok(Object.values(plaintexts).every(k=>!result.mutationSql.includes(k.toString())));
 assert.equal(result.environmentUpdate.remove[0],'DAILY_SYNC_CREDENTIAL_KEY_V1');
 assert.equal(result.safeSummary.providerCredentialsRevoked,false);
});
test('new observation secret cannot be a renamed old HKDF key or any old/new encryption key',()=>{
 for(const source of ['oldCredential','oldCheckpoint','oldObservation','newCredential']){
  const{input}=syntheticIncidentCryptoInput();
  input.newKeys.observationV2=source==='oldCredential'?input.oldKeys.credentialV1:source==='oldCheckpoint'?input.oldKeys.checkpoint:
   source==='newCredential'?input.newKeys.credentialV2:Buffer.from(hkdfSync('sha256',Buffer.from(input.oldKeys.credentialV1,'base64'),Buffer.from('cafe24-observation-v1'),Buffer.from('order-revision'),32)).toString('base64');
  assert.throws(()=>prepareIncidentCryptoTransform(input),/INCIDENT_CRYPTO_SAFE_REJECTED/);
 }
});
test('ciphertext/AAD, stale pointer, missing backup, duplicate rows and invalid scope reject safely',()=>{
 for(const mutate of [x=>{x.snapshot.credentials[0].kind='OTHER';},x=>{x.snapshot.checkpoints[0].unitKey='2026-01-01';},
  x=>{x.snapshot.checkpoints[0].checkpointValue='0'.repeat(64);},x=>{x.protectedSnapshotVerified=false;},
  x=>{x.snapshot.credentials[1]=x.snapshot.credentials[0];},x=>{x.projectRef='other';},x=>{x.snapshot.credentials[0].revision=-1;}]){
  const{input}=syntheticIncidentCryptoInput();mutate(input);assert.throws(()=>prepareIncidentCryptoTransform(input),/INCIDENT_CRYPTO_SAFE_REJECTED/);
 }
});
test('retired V1 is refused even when its old value is injected; independent V2 remains usable',()=>{
 const{input}=syntheticIncidentCryptoInput();
 const env={DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS:'1',DAILY_SYNC_CREDENTIAL_KEY_V1:input.oldKeys.credentialV1,DAILY_SYNC_CREDENTIAL_KEY_V2:input.newKeys.credentialV2};
 assert.throws(()=>credentialKey(1,env));const next=credentialKey(2,env);assert.equal(next.length,32);next.fill(0);
});
test('quarantine rejects historical observation use; explicit future V2 key is independent and does not need V1',()=>{
 const{input}=syntheticIncidentCryptoInput(),env=prepareIncidentCryptoTransform(input).environmentUpdate.set;
 assert.throws(()=>cafe24ObservationKey(env));
 const key=cafe24ObservationKey({...env,DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED:'false'});
 assert.equal(key.version,2);assert.ok(key.key.toString('base64')===input.newKeys.observationV2);key.key.fill(0);
});
