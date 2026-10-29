// Local PG17 membership option rehearsal. Never consumes a configured DB URL.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const require=createRequire(import.meta.url);
const runtime=resolve(process.env.LOCALAPPDATA,'UnifiedPerformanceStage02');
const {Client}=require(resolve(runtime,'node_modules/pg'));
const bin=resolve(runtime,'node_modules/@embedded-postgres/windows-x64/native/bin');
const root=resolve(runtime,`stage11-role-${randomUUID()}`),data=resolve(root,'data');
const port=55469;
mkdirSync(root,{recursive:true});
const child=(name,args)=>{const r=spawnSync(resolve(bin,name),args,{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);};
const evidence={stage:11,synthetic:true,remoteWrites:0,target:{host:'127.0.0.1',port,database:'postgres'},checks:[]};
let owner,admin,started=false;
try{
  child('initdb.exe',['-D',data,'-U','bootstrap_fixture','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
  child('pg_ctl.exe',['-D',data,'-l',resolve(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
  owner=new Client({host:'127.0.0.1',port,database:'postgres',user:'bootstrap_fixture'});await owner.connect();
  const identity=(await owner.query("SELECT current_user,inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];
  assert.equal(identity.current_user,'bootstrap_fixture');assert.match(identity.host,/^127\.0\.0\.1/);assert.match(identity.version,/^17/);
  await owner.query('CREATE ROLE stage11_executor LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB NOINHERIT; CREATE ROLE stage11_object_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; GRANT stage11_object_owner TO stage11_executor WITH ADMIN TRUE; GRANT stage11_object_owner TO stage11_executor WITH INHERIT FALSE; GRANT stage11_object_owner TO stage11_executor WITH SET FALSE;');
  const membership=async client=>(await client.query("SELECT a.oid::text,r.rolname role,m.rolname member,g.rolname grantor,a.admin_option,a.inherit_option,a.set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor WHERE r.rolname='stage11_object_owner' AND m.rolname='stage11_executor' ORDER BY a.oid")).rows;
  const before=await membership(owner);evidence.before=before;
  admin=new Client({host:'127.0.0.1',port,database:'postgres',user:'stage11_executor'});await admin.connect();
  await admin.query('BEGIN; GRANT stage11_object_owner TO stage11_executor WITH SET TRUE;');
  evidence.temporary=await membership(admin);
  await admin.query('SET LOCAL ROLE stage11_object_owner; RESET ROLE; GRANT stage11_object_owner TO stage11_executor WITH SET FALSE;');
  evidence.afterSetFalse=await membership(admin);
  evidence.exactRestoredBySetFalse=JSON.stringify(evidence.afterSetFalse)===JSON.stringify(before);
  assert.equal(evidence.exactRestoredBySetFalse,false,'SET FALSE alone must expose the leftover grantor-specific row');
  await admin.query('REVOKE stage11_object_owner FROM stage11_executor GRANTED BY stage11_executor');
  evidence.afterRevokeSelfGrant=await membership(admin);assert.deepEqual(evidence.afterRevokeSelfGrant,before);
  await admin.query('ROLLBACK');
  evidence.afterRollback=await membership(owner);assert.deepEqual(evidence.afterRollback,before);
  evidence.checks.push('Fresh loopback PG17; real nonsuperuser ADMIN=true INHERIT=false SET=false fixture','Temporary SET grant allows SET ROLE; SET FALSE leaves grantor-specific row; explicit own-grant REVOKE restores exact rows','Rollback also restores membership rows exactly');
  evidence.status='PASS';
}catch(error){evidence.status='FAIL';evidence.error=error.message;process.exitCode=1;}
finally{
  if(admin)await admin.end().catch(()=>{});if(owner)await owner.end().catch(()=>{});
  if(started){const stop=spawnSync(resolve(bin,'pg_ctl.exe'),['-D',data,'-m','fast','-w','stop'],{windowsHide:true,encoding:'utf8',timeout:30000});evidence.stopExitCode=stop.status;if(stop.status!==0)process.exitCode=1;}
  writeFileSync('docs/product-performance/research/11-deploy-role-rehearsal-result.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
}
