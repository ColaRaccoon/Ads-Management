// Private material is returned only to a protected parent over captured stdout.
import {generateKeyPairSync,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {validateDeploymentEvidence} from './deployment-evidence.mjs';
export function generateSigningMaterial() {
 const pair=generateKeyPairSync('ed25519');
 return {version:1,publicKeyB64:pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),
  privateKeyB64:pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64')};
}
export function signDeploymentPayload(material,payload) {
 let privateBytes=null;
 try {
  if(!material || material.version!==1 || typeof material.privateKeyB64!=='string' || typeof material.publicKeyB64!=='string')throw new Error('shape');
  privateBytes=Buffer.from(material.privateKeyB64,'base64');
  if(privateBytes.length!==48 || privateBytes.toString('base64')!==material.privateKeyB64)throw new Error('private');
  const key=createPrivateKey({key:privateBytes,format:'der',type:'pkcs8'});
  if(key.asymmetricKeyType!=='ed25519' || createPublicKey(key).export({format:'der',type:'spki'}).toString('base64')!==material.publicKeyB64)throw new Error('key');
  const envelope={payload,signatureB64:sign(null,Buffer.from(JSON.stringify(payload),'utf8'),key).toString('base64')};
  validateDeploymentEvidence(envelope,{sourceSha:payload?.sourceSha,deploymentId:payload?.deploymentId,publicKeyB64:material.publicKeyB64});
  return envelope;
 } catch {throw new Error('PHASE08_SCHEDULER_SIGNING_REJECTED');}
 finally {if(privateBytes)privateBytes.fill(0);}
}
async function main() {
 if(process.env.PHASE08_PROTECTED_PARENT!=='SCHEDULER_SIGNING_V1')throw new Error('parent');
 let bytes=0,chunks=[];
 for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>16384)throw new Error('size');chunks.push(chunk);}
 const inputBytes=Buffer.concat(chunks);let input;
 try {
  input=JSON.parse(inputBytes.toString('utf8'));
  if(input?.action==='generate' && Object.keys(input).length===1)process.stdout.write(JSON.stringify(generateSigningMaterial()));
  else if(input?.action==='sign' && Object.keys(input).length===3)process.stdout.write(JSON.stringify(signDeploymentPayload(input.material,input.payload)));
  else throw new Error('action');
 } finally {inputBytes.fill(0);input=null;chunks=[];}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
 process.stderr.write('PHASE08_SCHEDULER_CRYPTO_FAILED');process.exitCode=1;
});
