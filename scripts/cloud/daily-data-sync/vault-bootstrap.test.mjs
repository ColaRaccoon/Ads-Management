import test from 'node:test';
import assert from 'node:assert/strict';
import { vaultBootstrapSql, bindMachineVault } from './vault-bootstrap.mjs';
const now=Date.parse('2026-10-14T00:30:00.000Z');
const input={machineSha256:'a'.repeat(64),expiresAt:'2026-10-14T00:35:00.000Z'};
test('non-secret plan bounds exact hash and at most five-minute UTC expiry',()=>{
 for(const patch of [{machineSha256:[]},{machineSha256:'A'.repeat(64)},
   {machineSha256:"';SELECT"},{expiresAt:'2026-10-14T00:30:00.000Z'},
   {expiresAt:'2026-10-14T00:35:00.001Z'},{expiresAt:'2026-10-14T09:35:00+09:00'},
   {expiresAt:[]},{expiresAt:'invalid'}])
   assert.throws(()=>vaultBootstrapSql({...input,...patch},now),/PLAN_REJECTED/);
 const sql=vaultBootstrapSql(input,now);
 assert(sql.startsWith('BEGIN;'));assert(sql.endsWith('COMMIT;'));
 assert.match(sql,/session_user::text<>'phase08_runtime'/);
 assert.match(sql,/SECURITY DEFINER SET search_path=''/);
 assert.match(sql,/singleton FOR UPDATE/);
 assert.match(sql,/REVOKE EXECUTE[\s\S]*REVOKE USAGE/);
 assert.match(sql,/log_parameter_max_length_on_error/);
 assert.doesNotMatch(sql,/SQLERRM|RAISE[^;]*p_secret|decrypted_secrets/);
 assert.doesNotMatch(sql,/GRANT[^;]*(?:vault|ALL)/);
});
test('binding uses parameters and suppresses arbitrary driver errors',async()=>{
 const token=Buffer.alloc(32,255).toString('base64');let seen;
 const client={$queryRawUnsafe:async(...args)=>{seen=args;return[{state:'PHASE08_MACHINE_VAULT_CREATED'}]}};
 assert.deepEqual(await bindMachineVault(client,token),{state:'PHASE08_MACHINE_VAULT_CREATED',secretValuesReturned:0});
 assert(!seen[0].includes(token));assert.equal(seen[1],token);
 const throwing={$queryRawUnsafe:async()=>{throw new Error(token)}};
 await assert.rejects(bindMachineVault(throwing,token),e=>e.message==='PHASE08_VAULT_BIND_FAILED_INSPECT_BEFORE_RETRY'&&!e.message.includes(token));
 for(const value of [[],null,'short','a'.repeat(44),'='+'a'.repeat(42),'z'.repeat(43)+'=','a'.repeat(43)])
  await assert.rejects(bindMachineVault(client,value),/BIND_REJECTED/);
});
