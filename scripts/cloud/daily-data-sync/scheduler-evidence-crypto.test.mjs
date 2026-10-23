import test from 'node:test';
import assert from 'node:assert/strict';
import {generateSigningMaterial,signDeploymentPayload} from './scheduler-evidence-crypto.mjs';
import {ISOLATED_IDENTITY,FIXED_CONNECTIONS,validateDeploymentEvidence} from './deployment-evidence.mjs';
function payload() {
 const at=new Date().toISOString();
 return {kind:'PHASE08_ROOT_REVIEWED_DEPLOYMENT_V1',identity:{...ISOLATED_IDENTITY},sourceSha:'a'.repeat(64),
  deploymentId:'abcddcba-1234-4321-8123-123456789abc',deploymentStatus:'SUCCESS',observedAt:at,expiresAt:new Date(Date.parse(at)+600000).toISOString(),
  graphObservedAt:at,readyObservedAt:at,databaseObservedAt:at,
  database:{database:'postgres',privilegedRole:'postgres',runtimeRole:'phase08_runtime',schema:'phase08_meta_ads',tableCount:68,forceRlsCount:68,cronTimezone:'GMT',storageRenewalOpsPresent:false},
  connections:FIXED_CONNECTIONS.map(row=>{const kinds=row.provider==='CAFE24'?['CAFE24_ORDER']:row.provider==='GOOGLE'?['GOOGLE_CAMPAIGN']:['META_AD','META_ADSET'];
   return {...row,enabled:true,accessState:'READY',policyKinds:kinds,policyFromDates:Object.fromEntries(kinds.map(kind=>[kind,'2026-10-14']))};}),
  appSchedules:[],managementSchedules:[],featureEnabled:true,scheduleEnabled:false};
}
test('fresh ephemeral key signs bounded target evidence with no private output',()=>{
 const material=generateSigningMaterial(),p=payload();
 assert.equal(material.version,1);assert.equal(Buffer.from(material.privateKeyB64,'base64').length,48);
 assert.equal(Buffer.from(material.publicKeyB64,'base64').length,44);
 const proof=signDeploymentPayload(material,p);
 assert.deepEqual(validateDeploymentEvidence(proof,{sourceSha:p.sourceSha,deploymentId:p.deploymentId,publicKeyB64:material.publicKeyB64}),p);
 assert(!JSON.stringify(proof).includes(material.privateKeyB64));
});
test('mismatched key, bad encoding, foreign target and expired evidence return fixed failures',()=>{
 const first=generateSigningMaterial(),second=generateSigningMaterial();
 for(const [material,p] of [[{...first,publicKeyB64:second.publicKeyB64},payload()],
  [{...first,privateKeyB64:'bad'},payload()],[first,{...payload(),identity:{...ISOLATED_IDENTITY,projectRef:'iygjmosbelbosfxidqxv'}}],
  [first,{...payload(),expiresAt:'2000-01-01T00:00:00.000Z'}]])
  assert.throws(()=>signDeploymentPayload(material,p),e=>e.message==='PHASE08_SCHEDULER_SIGNING_REJECTED');
});
