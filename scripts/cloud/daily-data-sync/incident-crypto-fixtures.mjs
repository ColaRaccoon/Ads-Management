// Synthetic in-memory fixtures only. No external credential/file/network reads.
import { randomBytes,randomUUID,createCipheriv,createHash } from 'node:crypto';
import { createIncidentCryptoKeys } from './incident-crypto-transform.mjs';
export function syntheticIncidentCryptoInput(){
 const oldKeys={credentialV1:randomBytes(32).toString('base64'),checkpoint:randomBytes(32).toString('base64')};
 const connectionId='0c35defe-45fc-4a54-bc79-704df7bca5b1',runId=randomUUID();
 const encrypt=(plaintext,key,aad)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',Buffer.from(key,'base64'),iv);c.setAAD(Buffer.from(aad));
  return{ciphertextB64:Buffer.concat([c.update(plaintext),c.final()]).toString('base64'),ivB64:iv.toString('base64'),authTagB64:c.getAuthTag().toString('base64')};};
 const plaintexts={CAFE24_ACCESS:Buffer.from('SYNTHETIC_ONLY_ACCESS'),CAFE24_REFRESH:Buffer.from('SYNTHETIC_ONLY_REFRESH')};
 const credentials=Object.entries(plaintexts).map(([kind,value])=>({id:randomUUID(),connectionId,kind,keyVersion:1,revision:7,
  ...encrypt(value,oldKeys.credentialV1,`${connectionId}:${kind}:1`),expiresAt:'2026-10-31T17:00:16.000Z',refreshOwner:null,refreshUntil:null}));
 const checkpoints=['2026-10-16','2026-10-17'].map((unitKey,i)=>{const payload=Buffer.from(JSON.stringify({syntheticOnly:true,stage:'ITEMS_FIRST',count:1,rows:[]}));
  const row={runId,unitKey,connectionId,revision:6,expiresAt:i?'2026-10-20T19:00:19.119123Z':'2026-10-17T19:00:19.119123Z',...encrypt(payload,oldKeys.checkpoint,`${connectionId}:${runId}:${unitKey}`)};
  return{...row,checkpointValue:createHash('sha256').update(Buffer.from(row.ciphertextB64,'base64')).digest('hex')};});
 return{input:{projectRef:'ehnfrrmbkvlsbpvqcvkr',schema:'phase08_meta_ads',runtimeRole:'phase08_runtime',connectionId,
  operationKey:`20261019-crypto-${randomUUID()}`,protectedSnapshotVerified:true,oldKeys,newKeys:createIncidentCryptoKeys(),snapshot:{credentials,checkpoints}},plaintexts,runId};
}
