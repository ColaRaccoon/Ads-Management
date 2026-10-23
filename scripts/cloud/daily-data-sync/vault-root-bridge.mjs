// Root-only protected stdin bridge. Fixed target, bound secret, fixed diagnostics.
import {PrismaClient} from '@prisma/client';
import {createHash} from 'node:crypto';
import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';
import {bindMachineVault,vaultBootstrapSql} from './vault-bootstrap.mjs';
const settingsSql=`SELECT current_database() AS database, session_user::text AS role,
 current_setting('log_statement') AS statement, current_setting('pgaudit.log',true) AS audit,
 current_setting('pgaudit.log_parameter',true) AS audit_parameters,
 current_setting('log_parameter_max_length_on_error') AS error_parameters`;
export async function vaultRootBridge(input,factory=url=>new PrismaClient({datasourceUrl:url})) {
  let db;
  try {
    if(input?.action==='plan') {
      const sql=vaultBootstrapSql(input.plan),marker='AS $fn$',start=sql.indexOf(marker)+marker.length;
      const source=sql.slice(start,sql.indexOf('$fn$;',start));
      return {state:'PHASE08_VAULT_PLAN_PREPARED',sql,functionSourceSha256:createHash('sha256').update(source).digest('hex')};
    }
    if(!['inspect','bind'].includes(input?.action))throw new Error('PHASE08_VAULT_ROOT_REJECTED');
    db=factory(assertBusinessDatabaseTarget(input));
    await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const rows=await tx.$queryRawUnsafe(settingsSql);
      if(rows.length!==1 || rows[0].database!=='postgres' || rows[0].role!=='phase08_runtime' ||
        rows[0].statement!=='ddl' || rows[0].audit!=='none' || rows[0].audit_parameters!=='off' || rows[0].error_parameters!=='0')
        throw new Error('PHASE08_VAULT_LOGGING_REJECTED');
    },{timeout:20000,maxWait:2000});
    if(input.action==='inspect')return {state:'PHASE08_VAULT_RUNTIME_LOGGING_VERIFIED',targetWrites:0,secretValuesReturned:0};
    if(typeof input.machineSha256!=='string' || !/^[a-f0-9]{64}$/.test(input.machineSha256) ||
      typeof input.machineToken!=='string' || createHash('sha256').update(input.machineToken).digest('hex')!==input.machineSha256)
      throw new Error('PHASE08_VAULT_ROOT_REJECTED');
    return await bindMachineVault(db,input.machineToken);
  } finally {if(input && typeof input==='object')input.machineToken=null;if(db)await db.$disconnect();}
}
if(process.argv[1]?.endsWith('vault-root-bridge.mjs')) {
  let raw='';let input;
  try {for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>16384)throw new Error('INPUT_BOUND');}
    input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(await vaultRootBridge(input)));
  } catch {process.stdout.write('{"state":"PHASE08_VAULT_ROOT_FAILED_INSPECT_BEFORE_RETRY"}');process.exitCode=1;}
  finally {raw='';if(input)input.machineToken=null;input=null;}
}
