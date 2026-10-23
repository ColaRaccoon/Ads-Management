// Captured protected stdin/stdout only. No default secret reads or remote setup.
import {PrismaClient} from '@prisma/client';
import {createHash} from 'node:crypto';
import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';
import {relayVaultBootstrapSql,relayVaultBodySha256,assertRelayUserpwd,bindRelayVault} from './relay-vault-bootstrap.mjs';
const loggingSql=`SELECT current_database() AS database,session_user::text AS role,
 current_setting('log_statement') AS statement,current_setting('pgaudit.log',true) AS audit,
 current_setting('pgaudit.log_parameter',true) AS audit_parameters,
 current_setting('log_parameter_max_length_on_error') AS error_parameters,
 current_setting('log_min_messages') AS log_min,current_setting('client_min_messages') AS client_min`;
export async function relayVaultRootBridge(input,factory=url=>new PrismaClient({datasourceUrl:url})) {
 let db;
 try {
  if(input?.action==='plan') {const sql=relayVaultBootstrapSql(input.plan);return {state:'PHASE08_RELAY_VAULT_PLAN_PREPARED',sql,functionSourceSha256:relayVaultBodySha256(sql)};}
  if(!['inspect','bind'].includes(input?.action))throw new Error('PHASE08_RELAY_VAULT_ROOT_REJECTED');
  if(input.action==='bind') {
   assertRelayUserpwd(input.userpwd);
   if(typeof input.userpwdSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.userpwdSha256)||createHash('sha256').update(input.userpwd).digest('hex')!==input.userpwdSha256)throw new Error('PHASE08_RELAY_VAULT_ROOT_REJECTED');
  }
  db=factory(assertBusinessDatabaseTarget(input));
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');const rows=await tx.$queryRawUnsafe(loggingSql),row=rows[0];
   if(rows.length!==1||row.database!=='postgres'||row.role!=='phase08_runtime'||row.statement!=='ddl'||row.audit!=='none'||row.audit_parameters!=='off'||row.error_parameters!=='0'||!['info','notice','warning','error','log','fatal','panic'].includes(row.log_min)||!['info','notice','warning','error'].includes(row.client_min))throw new Error('PHASE08_RELAY_VAULT_LOGGING_REJECTED');
  },{timeout:20000,maxWait:2000});
  if(input.action==='inspect')return {state:'PHASE08_RELAY_VAULT_RUNTIME_LOGGING_VERIFIED',targetWrites:0,secretValuesReturned:0};
  return await bindRelayVault(db,input.userpwd);
 }finally{if(input&&typeof input==='object')input.userpwd=null;if(db)await db.$disconnect();}
}
if(process.argv[1]?.endsWith('relay-vault-root-bridge.mjs')) {
 let raw='',input;
 try{for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>16384)throw new Error('INPUT_BOUND');}input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(await relayVaultRootBridge(input)));}
 catch{process.stdout.write('{"state":"PHASE08_RELAY_VAULT_ROOT_FAILED_INSPECT_BEFORE_RETRY"}');process.exitCode=1;}
 finally{raw='';if(input&&typeof input==='object')input.userpwd=null;input=null;}
}
