// Protected stdin only. Reads only the new Cafe UUID in the fixed isolated runtime.
import {PrismaClient} from '@prisma/client';
import {createDecipheriv} from 'node:crypto';
import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';
const ID='0c35defe-45fc-4a54-bc79-704df7bca5b1';
const META_ID='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6';
function metaSecrets(env,buffers) {
 const ref=env.DAILY_SYNC_META_CREDENTIAL_REF;
 if(env.DAILY_SYNC_META_TRANSPORT!=='MCP'||typeof env.PHASE08_META_REF_UUID!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(env.PHASE08_META_REF_UUID)||ref!==`vault://meta/${env.PHASE08_META_REF_UUID}`)throw new Error('META_BINDING');
 const decode=(value,size)=>{if(typeof value!=='string'||value.length>65536)throw new Error('META_BOUND');const bytes=Buffer.from(value,'base64');buffers.push(bytes);if(bytes.toString('base64')!==value||(size!==undefined&&bytes.length!==size))throw new Error('META_BASE64');return bytes;};
 const record=decode(env.PHASE08_META_RECORD_B64);if(record.length<1||record.length>32768)throw new Error('META_BOUND');
 const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record));
 if(!envelope||envelope.version!==1||Object.keys(envelope).length!==4||!['version','iv','authTag','ciphertext'].every(key=>Object.hasOwn(envelope,key)))throw new Error('META_ENVELOPE');
 const key=decode(env.DAILY_SYNC_META_VAULT_KEY,32),iv=decode(envelope.iv,12),tag=decode(envelope.authTag,16),ciphertext=decode(envelope.ciphertext);
 // Exact original meta-protected-credential-resolver aad() contract, without resolve()'s HTTP probes.
 const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(JSON.stringify(['META_VAULT',1,'4474691502806219',ref,META_ID,'2138525300002203','MCP'])));decipher.setAuthTag(tag);
 const first=decipher.update(ciphertext);buffers.push(first);const last=decipher.final();buffers.push(last);const plain=Buffer.concat([first,last]);buffers.push(plain);
 const material=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
 if(material?.credentialRef!==ref||material.connectionId!==META_ID||material.accountId!=='2138525300002203'||material.transport!=='MCP'||
  !['token','inspectorToken'].every(key=>typeof material[key]==='string'&&/^[\x21-\x7e]{40,4096}$/.test(material[key])))throw new Error('META_MATERIAL');
 return [material.token,material.inspectorToken];
}
function variants(value) {const bytes=Buffer.from(value);try{return [value,JSON.stringify(value).slice(1,-1),encodeURIComponent(value),bytes.toString('base64')];}finally{bytes.fill(0);}}
export function scanKnownSecrets(logs,secrets,complete) {
 if(!Array.isArray(logs)||logs.length>5000||typeof complete!=='boolean'||!Array.isArray(secrets))throw new Error('BOUND');
 const text=JSON.stringify(logs);if(Buffer.byteLength(text)>1048576)throw new Error('BOUND');
 const values=[...new Set(secrets.filter(value=>typeof value==='string'&&value.length>=12&&value.length<=1048576).flatMap(variants))];
 const matched=values.some(value=>text.includes(value));
 return {state:matched?'PHASE08_SECRET_MATCH_DETECTED':complete&&logs.length<5000?'PHASE08_SECRET_SCAN_COMPLETE':'PHASE08_SECRET_SCAN_INCOMPLETE',
  matchDetected:matched,complete:complete&&logs.length<5000,logEntries:logs.length,secretCandidates:values.length,rawValuesReturned:0,providerRequests:0,databaseWrites:0};
}
function environmentSecrets(env) {
 const secrets=[];
 // Role and subject are public JWT claim configuration, never the signed token.
 // Do not classify their normal presence in database/gateway metadata as a leak.
 const publicClaimConfiguration=new Set(['SUPABASE_STORAGE_TOKEN_ROLE','SUPABASE_STORAGE_TOKEN_SUBJECT']);
 for(const [name,value] of Object.entries(env))if(!publicClaimConfiguration.has(name)&&/TOKEN|SECRET|PASSWORD|CREDENTIAL_KEY|CHECKPOINT_KEY|VAULT_KEY|RECORD_B64|ADC_JSON_B64/.test(name)&&typeof value==='string')secrets.push(value);
 if(typeof env.DATABASE_URL==='string')secrets.push(decodeURIComponent(new URL(env.DATABASE_URL).password));
 if(env.PHASE08_GOOGLE_ADC_JSON_B64) {
  const bytes=Buffer.from(env.PHASE08_GOOGLE_ADC_JSON_B64,'base64');
  try {const adc=JSON.parse(bytes.toString('utf8'));
   for(const name of ['refresh_token','client_secret','access_token','private_key'])for(const row of [adc,adc.source_credentials])if(typeof row?.[name]==='string')secrets.push(row[name]);
  }finally{bytes.fill(0);}
 }
 return secrets;
}
export async function scanDeployment(input,factory=url=>new PrismaClient({datasourceUrl:url})) {
 const env=input?.env;const buffers=[];let db,tokens=[],secrets=[];
 try {
  if(!env||input.projectRef!=='ehnfrrmbkvlsbpvqcvkr'||input.connectionId!==ID||env.SUPABASE_DATABASE_SCHEMA!=='phase08_meta_ads'||env.SUPABASE_DATABASE_RUNTIME_USER!=='phase08_runtime')throw new Error('TARGET');
  const url=assertBusinessDatabaseTarget({projectRef:input.projectRef,freshVerified:true,databaseUrl:env.DATABASE_URL});
  scanKnownSecrets(input.logs,[],input.logsComplete);db=factory(url);
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
   const identity=await tx.$queryRawUnsafe("SELECT current_database() AS database,current_user AS role,current_schema() AS schema,current_setting('transaction_read_only') AS readonly");
   if(identity.length!==1||identity[0].database!=='postgres'||identity[0].role!=='phase08_runtime'||identity[0].schema!=='phase08_meta_ads'||identity[0].readonly!=='on')throw new Error('IDENTITY');
   const rows=await tx.sourceCredential.findMany({where:{connectionId:ID},select:{connectionId:true,kind:true,ciphertext:true,iv:true,authTag:true,keyVersion:true}});
   if(rows.length!==2||new Set(rows.map(row=>row.kind)).size!==2||rows.some(row=>row.connectionId!==ID||!['CAFE24_ACCESS','CAFE24_REFRESH'].includes(row.kind)))throw new Error('PAIR');
   for(const row of rows) {
    const encoded=env[`DAILY_SYNC_CREDENTIAL_KEY_V${row.keyVersion}`];
    if(!Number.isInteger(row.keyVersion)||row.keyVersion<1||row.keyVersion>99||typeof encoded!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(encoded))throw new Error('KEY');
    const key=Buffer.from(encoded,'base64');buffers.push(key);if(key.length!==32||key.toString('base64')!==encoded||row.iv.length!==12||row.authTag.length!==16||row.ciphertext.length<1||row.ciphertext.length>8192)throw new Error('ENVELOPE');
    const decipher=createDecipheriv('aes-256-gcm',key,row.iv);decipher.setAAD(Buffer.from(`${ID}:${row.kind}:${row.keyVersion}`));decipher.setAuthTag(row.authTag);
    const first=decipher.update(row.ciphertext);buffers.push(first);const last=decipher.final();buffers.push(last);
    const plain=Buffer.concat([first,last]);buffers.push(plain);if(plain.length<12)throw new Error('TOKEN');tokens.push(new TextDecoder('utf-8',{fatal:true}).decode(plain));
   }
  },{timeout:20000,maxWait:2000});
  secrets=[...environmentSecrets(env),...metaSecrets(env,buffers)];return {...scanKnownSecrets(input.logs,[...secrets,...tokens],input.logsComplete),cafeCredentialsDecrypted:tokens.length,metaCredentialsDecrypted:2};
 } finally {try {if(db)await db.$disconnect();}finally {buffers.forEach(value=>value.fill(0));tokens=[];secrets=[];if(input&&typeof input==='object'){input.env=undefined;input.logs=undefined;}}}
}
if(process.argv[1]?.endsWith('scan-deployment-secrets.mjs')) {
 let raw='';let input;
 try {for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>1048576)throw new Error('BOUND');}input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(await scanDeployment(input)));}
 catch {process.stdout.write(JSON.stringify({state:'PHASE08_SECRET_SCAN_FAILED',rawErrorSuppressed:true,complete:false}));process.exitCode=1;}
 finally {raw='';input=undefined;}
}
