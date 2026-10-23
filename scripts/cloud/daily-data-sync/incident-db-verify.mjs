import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {parseIncidentDatabaseUrl} from './incident-core.mjs';
const require=createRequire(import.meta.url),{Client}=require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
const ca=readFileSync('C:/Users/seong/Desktop/workspace/Meta-Ads-Performance/deploy/cloud/certs/supabase-prod-ca-2021.crt','utf8');
function client(value){const u=parseIncidentDatabaseUrl(value);for(const k of ['schema','connection_limit','pool_timeout','connect_timeout','sslmode'])u.searchParams.delete(k);return new Client({connectionString:u.href,ssl:{ca,rejectUnauthorized:true},connectionTimeoutMillis:15000,query_timeout:15000,application_name:'incident-old-new-password-check'});}
try{
 let wire='';for await(const c of process.stdin){wire+=c;if(wire.length>65536)throw Error();}const input=JSON.parse(wire);wire='';
 if(input.oldUrl===input.newUrl)throw Error();let oldRejected=false,oldCode=null;const old=client(input.oldUrl);
 try{await old.connect();}catch(e){oldCode=e.code;oldRejected=e.code==='28P01';}finally{await old.end().catch(()=>{});}
 if(!oldRejected)throw Error();const fresh=client(input.newUrl);let heldDenied=0;
 try{
  await fresh.connect();const r=await fresh.query("BEGIN READ ONLY;SELECT current_user AS role,current_database() AS db,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS force_rls;COMMIT;");
  const row=r[1].rows[0];if(row.role!=='phase08_runtime'||row.db!=='postgres'||row.force_rls!==68)throw Error();
  for(const table of ['source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints']){try{await fresh.query(`SELECT 1 FROM phase08_meta_ads.${table} LIMIT 0`);}catch(e){if(e.code==='42501')heldDenied++;else throw Error();}}
  if(heldDenied!==4)throw Error();
 }finally{await fresh.end().catch(()=>{});}
 process.stdout.write(JSON.stringify({kind:'INCIDENT_DATABASE_AUTH_VERIFIED',oldPasswordRejected:true,oldSqlState:oldCode,newPasswordAccepted:true,runtimeIdentityMatched:true,forceRls:68,heldTableAccessDenied:heldDenied,tlsCertificateVerified:true,providerRequests:0,businessWrites:0}));
}catch{process.stdout.write(JSON.stringify({kind:'INCIDENT_DATABASE_AUTH_SAFE_FAILURE',rawErrorSuppressed:true}));process.exitCode=1;}
