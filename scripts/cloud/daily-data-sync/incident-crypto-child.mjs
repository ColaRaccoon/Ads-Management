// Protected IPC only. Never launch with stdout connected to a tool response.
import {createDecipheriv,createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createIncidentCryptoKeys,incidentCryptoSnapshotSql,prepareIncidentCryptoTransform} from './incident-crypto-transform.mjs';
const fail=()=>{throw Error('INCIDENT_CRYPTO_CHILD_SAFE_REJECTED');};
function decrypt(row,key,aad){
 const material=Buffer.from(key,'base64');let plain;
 try{
  const c=createDecipheriv('aes-256-gcm',material,Buffer.from(row.ivB64,'base64'));c.setAAD(Buffer.from(aad));c.setAuthTag(Buffer.from(row.authTagB64,'base64'));
  plain=Buffer.concat([c.update(Buffer.from(row.ciphertextB64,'base64')),c.final()]);return plain;
 }catch{plain?.fill(0);return fail();}finally{material.fill(0);}
}
function equals(a,b){return a.length===b.length&&timingSafeEqual(a,b);}
function verify(input,after){
 // Revalidate the protected before-image and key independence. This pure
 // preparation performs no DB/provider operation and its unused SQL is dropped.
 prepareIncidentCryptoTransform(input);
 if(!Array.isArray(after?.credentials)||after.credentials.length!==2||!Array.isArray(after?.checkpoints)||after.checkpoints.length!==input.snapshot.checkpoints.length)fail();
 let oldCredentialRejected=0,oldCheckpointRejected=0;
 for(const before of input.snapshot.credentials){
  const row=after.credentials.find(r=>r.id===before.id);
  if(!row||row.connectionId!==before.connectionId||row.kind!==before.kind||row.keyVersion!==2||row.revision!==before.revision+1||
    row.expiresAt!==before.expiresAt||row.refreshOwner!==null||row.refreshUntil!==null||row.ciphertextB64===before.ciphertextB64)fail();
  const oldAad=`${before.connectionId}:${before.kind}:1`,newAad=`${row.connectionId}:${row.kind}:2`;
  const old=decrypt(before,input.oldKeys.credentialV1,oldAad),fresh=decrypt(row,input.newKeys.credentialV2,newAad);
  try{if(!equals(old,fresh))fail();}finally{old.fill(0);fresh.fill(0);}
  try{const unexpected=decrypt(row,input.oldKeys.credentialV1,newAad);unexpected.fill(0);}catch{oldCredentialRejected++;}
 }
 for(const before of input.snapshot.checkpoints){
  const row=after.checkpoints.find(r=>r.runId===before.runId&&r.unitKey===before.unitKey);
  if(!row||row.connectionId!==before.connectionId||row.revision!==before.revision+1||row.expiresAt!==before.expiresAt||row.ciphertextB64===before.ciphertextB64||
    row.checkpointValue!==createHash('sha256').update(Buffer.from(row.ciphertextB64,'base64')).digest('hex'))fail();
  const aad=`${row.connectionId}:${row.runId}:${row.unitKey}`,old=decrypt(before,input.oldKeys.checkpoint,aad),fresh=decrypt(row,input.newKeys.checkpoint,aad);
  try{if(!equals(old,fresh))fail();}finally{old.fill(0);fresh.fill(0);}
  try{const unexpected=decrypt(row,input.oldKeys.checkpoint,aad);unexpected.fill(0);}catch{oldCheckpointRejected++;}
 }
 if(oldCredentialRejected!==2||oldCheckpointRejected!==after.checkpoints.length)fail();
 return{verified:true,credentialRows:2,checkpointRows:after.checkpoints.length,newCredentialKeyDecryptsSamePlaintext:true,oldCredentialKeyCannotDecryptNewCiphertext:true,
  newCheckpointKeyDecryptsSamePlaintext:true,oldCheckpointKeyCannotDecryptNewCiphertext:true,oldCredentialVersionRemaining:0,expiryAndRevisionPreserved:true,
  checkpointPointersVerified:true,providerCredentialsRevoked:false,providerRequests:0,rawValuesReturned:0};
}
export function runIncidentCryptoChild(request){
 if(request?.operation==='GENERATE')return createIncidentCryptoKeys();
 if(request?.operation==='SNAPSHOT_SQL')return{sql:incidentCryptoSnapshotSql()};
 if(request?.operation==='PREPARE')return prepareIncidentCryptoTransform(request.input);
 if(request?.operation==='VERIFY')return verify(request.input,request.after);
 return fail();
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 let raw='';
 try{
  if(process.env.INCIDENT_CRYPTO_PROTECTED_PARENT!=='20261019-ROOT')fail();
  for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>4194304)fail();}
  const request=JSON.parse(raw);raw='';const result=runIncidentCryptoChild(request);const wire=JSON.stringify(result);
  if(Buffer.byteLength(wire)>12582912)fail();process.stdout.write(wire);
 }catch{raw='';process.stderr.write('INCIDENT_CRYPTO_CHILD_SAFE_REJECTED');process.exitCode=1;}
}
