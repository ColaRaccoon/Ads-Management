import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createPublicKey,verify} from 'node:crypto';
import {renewStorage} from './recover-october19-storage.mjs';
function fixture(){
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),jwk={...privateKey.export({format:'jwk'}),kid:'synthetic-only'};
 const claims={iss:'https://ehnfrrmbkvlsbpvqcvkr.supabase.co/auth/v1',aud:'authenticated',sub:'synthetic-subject',role:'phase08_storage_app',iat:10,exp:100};
 const body=[{alg:'ES256',typ:'JWT',kid:jwk.kid},claims].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
 const token=body+'.'+sign('sha256',Buffer.from(body),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return {jwk,publicJwks:{keys:[createPublicKey(privateKey).export({format:'jwk'})].map(x=>({...x,kid:jwk.kid}))},env:{SUPABASE_URL:'https://ehnfrrmbkvlsbpvqcvkr.supabase.co',SUPABASE_DATABASE_PROJECT_REF:'ehnfrrmbkvlsbpvqcvkr',SUPABASE_DATABASE_SCHEMA:'phase08_meta_ads',SUPABASE_DATABASE_RUNTIME_USER:'phase08_runtime',SUPABASE_STORAGE_BUCKET:'meta-ads-phase08-isolated',SUPABASE_STORAGE_TOKEN_ROLE:'phase08_storage_app',SUPABASE_STORAGE_TOKEN_SUBJECT:claims.sub,SUPABASE_STORAGE_ACCESS_TOKEN:token}};
}
test('signed renewal changes only issued/expiry claims for exactly six days',()=>{const input=fixture(),result=renewStorage(input,200),parts=result.token.split('.'),old=JSON.parse(Buffer.from(input.env.SUPABASE_STORAGE_ACCESS_TOKEN.split('.')[1],'base64url')),fresh=JSON.parse(Buffer.from(parts[1],'base64url'));assert.deepEqual(fresh,{...old,iat:200,exp:200+6*86400});assert(verify('sha256',Buffer.from(parts.slice(0,2).join('.')),{key:createPublicKey({key:input.jwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')));});
test('operating project, wider role, other bucket and other subject all fail closed',()=>{for(const [key,value] of [['SUPABASE_DATABASE_PROJECT_REF','iygjmosbelbosfxidqxv'],['SUPABASE_STORAGE_TOKEN_ROLE','service_role'],['SUPABASE_STORAGE_BUCKET','operating-bucket'],['SUPABASE_STORAGE_TOKEN_SUBJECT','another-subject']]){const input=fixture();input.env[key]=value;assert.throws(()=>renewStorage(input,200));}});
test('untrusted public key metadata and tampered previous signature cannot renew',()=>{const input=fixture();input.publicJwks.keys[0].x='untrusted';assert.throws(()=>renewStorage(input,200));const other=fixture();const parts=other.env.SUPABASE_STORAGE_ACCESS_TOKEN.split('.');parts[2]='A'.repeat(86);other.env.SUPABASE_STORAGE_ACCESS_TOKEN=parts.join('.');assert.throws(()=>renewStorage(other,200));});
