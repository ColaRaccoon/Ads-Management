import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {relayVaultBootstrapSql,relayVaultBodySha256,relayVaultDropSql} from './relay-vault-bootstrap.mjs';
import {relayVaultRootBridge} from './relay-vault-root-bridge.mjs';
const userpwd='phase08-scheduler:'+Buffer.alloc(32,5).toString('base64'),hash=createHash('sha256').update(userpwd).digest('hex');
const material=()=>({action:'bind',projectRef:'ehnfrrmbkvlsbpvqcvkr',freshVerified:true,databaseUrl:'postgresql://phase08_runtime.ehnfrrmbkvlsbpvqcvkr:SYNTHETIC_PASSWORD_ONLY@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=phase08_meta_ads&sslmode=verify-full',userpwd,userpwdSha256:hash});
function mock(changes={}){let bind=0,disconnected=false;const db={$transaction:async cb=>cb({$executeRawUnsafe:async sql=>assert.equal(sql,'SET TRANSACTION READ ONLY'),$queryRawUnsafe:async()=>[{database:'postgres',role:'phase08_runtime',statement:'ddl',audit:'none',audit_parameters:'off',error_parameters:'0',log_min:'warning',client_min:'notice',...changes}]}),$queryRawUnsafe:async(sql,value)=>{bind++;assert.equal(sql,'SELECT daily_data_sync_ops.bootstrap_relay($1::text) AS state');assert.equal(value,userpwd);return [{state:'PHASE08_RELAY_VAULT_CREATED'}];},$disconnect:async()=>{disconnected=true;}};return {db,get bind(){return bind;},get disconnected(){return disconnected;}};}
test('fresh ON/152-record relay bootstrap is separate from old machine setup; TTL/hash/privilege cleanup source digest exact',()=>{
 const expiresAt=new Date(Date.now()+240000).toISOString(),sql=relayVaultBootstrapSql({userpwdSha256:hash,expiresAt});
 assert.match(sql,/NOT stopped/);assert.match(sql,/attempts\)<>152/);assert.match(sql,/<>149/);assert.match(sql,/bootstrap_relay/);assert.match(sql,/DAILY_SYNC_RELAY_VAULT_CREATED/);assert(!sql.includes(userpwd));assert.match(sql,/REVOKE EXECUTE/);assert.match(sql,/log_min_messages/);
 const digest=relayVaultBodySha256(sql);assert.match(digest,/^[a-f0-9]{64}$/);assert(relayVaultDropSql(digest).includes(digest));assert.throws(()=>relayVaultDropSql('bad'));
 assert.throws(()=>relayVaultBootstrapSql({userpwdSha256:hash,expiresAt:new Date(Date.now()+600000).toISOString()}));
});
test('protected bind uses one parameter only after readonly logging and clears input; inspect cannot bind',async()=>{
 const m=mock(),input=material();const result=await relayVaultRootBridge(input,()=>m.db);assert.equal(result.state,'PHASE08_RELAY_VAULT_CREATED');assert.equal(m.bind,1);assert(m.disconnected);assert.equal(input.userpwd,null);assert(!JSON.stringify(result).includes(userpwd));
 const n=mock(),inspect={...material(),action:'inspect'};assert.equal((await relayVaultRootBridge(inspect,()=>n.db)).targetWrites,0);assert.equal(n.bind,0);assert.equal(inspect.userpwd,null);
});
test('wrong logging/hash/target/factory fail before bind and always clear protected userpwd, with no retry',async()=>{
 for(const changes of [{log_min:'debug2'},{client_min:'debug1'},{statement:'all'},{audit_parameters:'on'}]){const m=mock(changes),input=material();await assert.rejects(relayVaultRootBridge(input,()=>m.db));assert.equal(input.userpwd,null);assert.equal(m.bind,0);assert(m.disconnected);}
 for(const mutate of [input=>input.userpwdSha256='a'.repeat(64),input=>input.projectRef='foreign']){const input=material();mutate(input);await assert.rejects(relayVaultRootBridge(input,()=>{throw Error('SYNTHETIC_PRIVATE');}));assert.equal(input.userpwd,null);}
 const bad=material();await assert.rejects(relayVaultRootBridge(bad,()=>{throw Error('SYNTHETIC_PRIVATE');}));assert.equal(bad.userpwd,null);
});
