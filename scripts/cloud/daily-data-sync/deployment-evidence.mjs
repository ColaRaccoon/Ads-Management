import {createPublicKey,verify} from 'node:crypto';
export const ISOLATED_IDENTITY=Object.freeze({projectId:'d72f4256-8632-437a-9dae-9b5d96736fc7',environmentId:'d261a432-a6a4-4031-b8ea-c619ac263cc3',serviceId:'4b30daa8-9333-46b7-ad89-cfd64ff5266c',origin:'https://phase08-daily-data-sync-production.up.railway.app',projectRef:'ehnfrrmbkvlsbpvqcvkr',schema:'phase08_meta_ads',runtimeUser:'phase08_runtime',targetId:'phase08-full-app',releaseSha:'9e9a1f82bb02346575565b031a43e17e13758dc8',readyFingerprint:'a08ce01407eaa8070887c23195685f3d475674b89a0dc3bd2c7315bf404a0aa1'});
// Root supplies these literal pins only after independently reviewing the artifact and its
// actual deployment. Empty pins always prohibit mutable scheduler actions.
export const REVIEWED_SOURCE_SHA256='0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1';
export const REVIEWED_DEPLOYMENT_ID='33677c6c-2142-4938-b7f0-95e96f5de86b';
export const REVIEWED_EVIDENCE_PUBLIC_KEY_B64='MCowBQYDK2VwAyEAInoewcY3imWTZBEbnGZM5yfxowDer2dagJNs+hZOhZg=';
export const FIXED_CONNECTIONS=Object.freeze([
  {provider:'CAFE24',connectionId:'0c35defe-45fc-4a54-bc79-704df7bca5b1',account:'didadi0729',shop:'shop1',currency:'KRW',timeZone:'Asia/Seoul'},
  {provider:'GOOGLE',connectionId:'b9ebee4b-5d4e-4eae-92b9-9facfbf3c900',account:'1391592099',shop:'default',currency:'KRW',timeZone:'Asia/Seoul'},
  {provider:'META',connectionId:'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',account:'2138525300002203',shop:'default',currency:'USD',timeZone:'Asia/Seoul'}]);
const fail=()=>{throw new Error('STAGING_DEPLOYMENT_EVIDENCE_REJECTED');};
const keys=(value,expected)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===expected.length && expected.every(key=>Object.hasOwn(value,key));
function timestamp(value) {if(typeof value!=='string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString()!==value)fail();return Date.parse(value);}
/** Pure validator accepts explicit trusted pins for synthetic tests; execution
 * entry points always call assertReviewedDeployment with the literal pins. */
export function validateDeploymentEvidence(envelope,pins,now=Date.now()) {
  if(!pins || !/^[a-f0-9]{64}$/.test(pins.sourceSha??'') || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pins.deploymentId??'') || !pins.publicKeyB64)fail();
  if(!keys(envelope,['payload','signatureB64']) || typeof envelope.signatureB64!=='string' || envelope.signatureB64.length!==88)fail();
  const payload=envelope.payload;
  if(!keys(payload,['kind','identity','sourceSha','deploymentId','deploymentStatus','observedAt','expiresAt','graphObservedAt','readyObservedAt','databaseObservedAt','database','connections','appSchedules','managementSchedules','featureEnabled','scheduleEnabled']))fail();
  if(payload.kind!=='PHASE08_ROOT_REVIEWED_DEPLOYMENT_V1' || !keys(payload.identity,Object.keys(ISOLATED_IDENTITY)) ||
    Object.entries(ISOLATED_IDENTITY).some(([key,value])=>payload.identity[key]!==value) || payload.sourceSha!==pins.sourceSha || payload.deploymentId!==pins.deploymentId || !['SUCCESS','SLEEPING'].includes(payload.deploymentStatus))fail();
  const observed=timestamp(payload.observedAt),expiry=timestamp(payload.expiresAt);
  if(observed>now+5000 || observed<now-900000 || expiry<=now || expiry>observed+900000 || expiry<=observed)fail();
  for(const key of ['graphObservedAt','readyObservedAt','databaseObservedAt']) {const at=timestamp(payload[key]);if(at>observed+5000 || at<observed-300000 || at<now-900000)fail();}
  if(!keys(payload.database,['database','privilegedRole','runtimeRole','schema','tableCount','forceRlsCount','cronTimezone','storageRenewalOpsPresent']) ||
    payload.database.database!=='postgres' || payload.database.privilegedRole!=='postgres' || payload.database.runtimeRole!=='phase08_runtime' || payload.database.schema!=='phase08_meta_ads' ||
    payload.database.tableCount!==68 || payload.database.forceRlsCount!==68 || !['UTC','GMT'].includes(payload.database.cronTimezone) || payload.database.storageRenewalOpsPresent!==false)fail();
  if(!Array.isArray(payload.connections) || payload.connections.length!==3 || typeof payload.featureEnabled!=='boolean' || typeof payload.scheduleEnabled!=='boolean' || !payload.featureEnabled || !Array.isArray(payload.appSchedules) || !Array.isArray(payload.managementSchedules) || ![0,3].includes(payload.appSchedules.length) || ![0,3].includes(payload.managementSchedules.length))fail();
  for(const expected of FIXED_CONNECTIONS) {
    const matches=payload.connections.filter(row=>row?.provider===expected.provider);
    if(matches.length!==1 || !keys(matches[0],[...Object.keys(expected),'enabled','accessState','policyKinds','policyFromDates']) || Object.entries(expected).some(([key,value])=>matches[0][key]!==value) || matches[0].enabled!==true || matches[0].accessState!=='READY')fail();
    const wanted=expected.provider==='CAFE24'?['CAFE24_ORDER']:expected.provider==='GOOGLE'?['GOOGLE_CAMPAIGN']:['META_AD','META_ADSET'];
    if(!Array.isArray(matches[0].policyKinds) || JSON.stringify([...matches[0].policyKinds].sort())!==JSON.stringify(wanted.sort()))fail();
    if(!keys(matches[0].policyFromDates,wanted) || wanted.some(kind=>typeof matches[0].policyFromDates[kind]!=='string' || !/^\d{4}-\d\d-\d\d$/.test(matches[0].policyFromDates[kind]) || new Date(matches[0].policyFromDates[kind]).toISOString().slice(0,10)!==matches[0].policyFromDates[kind]))fail();
  }
  try {
    const bytes=Buffer.from(envelope.signatureB64,'base64');
    if(bytes.length!==64 || bytes.toString('base64')!==envelope.signatureB64)fail();
    const keyBytes=Buffer.from(pins.publicKeyB64,'base64');if(keyBytes.toString('base64')!==pins.publicKeyB64)fail();
    const key=createPublicKey({key:keyBytes,format:'der',type:'spki'});if(key.asymmetricKeyType!=='ed25519')fail();
    if(!verify(null,Buffer.from(JSON.stringify(payload)),key,bytes))fail();
  } catch {fail();}
  return structuredClone(payload);
}
export function assertReviewedDeployment(envelope) {
  if(!REVIEWED_SOURCE_SHA256 || !REVIEWED_DEPLOYMENT_ID || !REVIEWED_EVIDENCE_PUBLIC_KEY_B64)throw new Error('STAGING_APP_NOT_PROVISIONED');
  return validateDeploymentEvidence(envelope,{sourceSha:REVIEWED_SOURCE_SHA256,deploymentId:REVIEWED_DEPLOYMENT_ID,publicKeyB64:REVIEWED_EVIDENCE_PUBLIC_KEY_B64});
}
