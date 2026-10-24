// Synthetic-only credential lifecycle boundaries. No real credential store or provider I/O.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, realpath, writeFile, unlink, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {resolveMetaCredential, configuredMetaTransport} from '../../../apps/api/src/daily-sync/meta-credential-resolver';
import {ProtectedFileMetaCredentialResolver, sealMetaVaultRecord} from '../../../apps/api/src/daily-sync/meta-protected-credential-resolver';
import {assertMetaOperatingGate} from '../../../apps/api/src/daily-sync/meta-operating-gate';
import {MetaCredentialBindingService} from '../../../apps/api/src/daily-sync/meta-credential-binding.service';
import {accountKey} from '../../../apps/api/src/daily-sync/source-connections.service';

const DAY=86400000, now=new Date('2026-10-21T00:00:00.000Z');
const binding={credentialRef:'vault://meta/00000000-0000-4000-8000-000000000011',
  connectionId:'00000000-0000-4000-8000-000000000012',accountId:'2138525300002203',transport:'MCP' as const};
const synthetic={...binding,token:'SYNTHETIC_ONLY_NOT_A_PROVIDER_TOKEN_'.repeat(3),
  inspectorToken:'SYNTHETIC_ONLY_NOT_AN_INSPECTOR_TOKEN_'.repeat(3)};
const resolved={...binding,token:synthetic.token,appId:'4474691502806219',authClass:'SYSTEM_USER' as const,
  scopes:['ads_read','ads_mcp_management'],currencyCode:'USD',timeZone:'Asia/Seoul',expiresAt:new Date(+now+30*DAY)};

test('own-account MCP support does not require direct Graph Full approval',()=>{
  const env={DAILY_SYNC_META_TRANSPORT:'MCP',DAILY_SYNC_META_MCP_USE_CASE:'OWN_ACCOUNT_INTERNAL_REPORTING'};
  assert.equal(configuredMetaTransport(env),'MCP');
  assert.doesNotThrow(()=>assertMetaOperatingGate('MCP',env));
  assert.throws(()=>assertMetaOperatingGate('MCP',{...env,DAILY_SYNC_META_MCP_USE_CASE:'OTHER_BUSINESS'}));
  assert.throws(()=>assertMetaOperatingGate('GRAPH',{DAILY_SYNC_META_TRANSPORT:'GRAPH'}));
});
test('finite TTL strictly above seven days is sufficient; a permanent token is not required',async()=>{
  for(const expiresAt of [new Date(+now-1),new Date(+now+7*DAY),new Date(NaN)])
    await assert.rejects(resolveMetaCredential({resolve:async()=>({...resolved,expiresAt})},binding,now));
  const result=await resolveMetaCredential({resolve:async()=>({...resolved,expiresAt:new Date(+now+7*DAY+1)})},binding,now);
  assert.equal(result.expiresAt.getTime(),+now+7*DAY+1);
});
test('new binding rejects substitution, extra write scope and missing MCP permission',async()=>{
  for(const patch of [{accountId:'1'},{appId:'1'},{authClass:'USER'},
    {scopes:['ads_read']},{scopes:['ads_read','ads_mcp_management','ads_management']},
    {transport:'GRAPH'},{currencyCode:'KRW'},{timeZone:'UTC'}])
    await assert.rejects(resolveMetaCredential({resolve:async()=>({...resolved,...patch} as any)},binding,now));
});
test('credential backend deadline aborts and fails closed without a provider request',async()=>{
  let aborted=false;
  await assert.rejects(resolveMetaCredential({resolve:async(_input,signal)=>new Promise((_ok,reject)=>{
    signal.addEventListener('abort',()=>{aborted=true;reject(Error('SYNTHETIC_ABORT'));},{once:true});
  })},binding,now,5));
  assert.equal(aborted,true);
});

async function withProtectedFixture(run:(value:{resolver:ProtectedFileMetaCredentialResolver;
  file:string; calls:string[]; data:Record<string,unknown>; key:Buffer})=>Promise<void>){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'phase10-meta-synthetic-')));
  const file=join(dir,'00000000-0000-4000-8000-000000000011.json'),key=randomBytes(32),calls:string[]=[];
  const seconds=Math.floor(Date.now()/1000);
  const data:Record<string,unknown>={app_id:'4474691502806219',type:'SYSTEM_USER',is_valid:true,
    scopes:['ads_read','ads_mcp_management'],user_id:'12345',expires_at:seconds+30*86400,
    data_access_expires_at:seconds+20*86400};
  await writeFile(file,sealMetaVaultRecord(synthetic,key),{flag:'wx',mode:0o600});
  const request=async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(String(input));
    assert.equal(url.origin,'https://graph.facebook.com');
    assert.equal(init?.redirect,'error');
    const route=url.pathname.replace('/v26.0/','');calls.push(route);
    if(route==='debug_token')return Response.json({data});
    if(route==='me')return Response.json({id:'12345'});
    if(route==='act_2138525300002203')return Response.json({id:'2138525300002203',currency:'USD',timezone_name:'Asia/Seoul'});
    throw Error('SYNTHETIC_UNEXPECTED_ROUTE');
  };
  try{await run({resolver:new ProtectedFileMetaCredentialResolver(dir,key.toString('base64'),request as any),file,calls,data,key});}
  finally{key.fill(0);await unlink(file).catch((error)=>{if(error.code!=='ENOENT')throw error;});await rmdir(dir);}
}
test('actual GCM protected backend uses app/type/account/scopes and the earlier data-access expiry',async()=>{
  await withProtectedFixture(async({resolver,calls,data})=>{
    const credential=await resolver.resolve(binding,new AbortController().signal);
    assert.equal(credential.expiresAt.getTime(),Number(data.data_access_expires_at)*1000);
    assert.deepEqual(calls,['debug_token','me','act_2138525300002203']);
  });
});
test('revoked, short-lived or overprivileged token stops before account reads',async()=>{
  for(const change of [{is_valid:false},{type:'USER'},{app_id:'0'},
    {data_access_expires_at:Math.floor(Date.now()/1000)+7*86400},
    {scopes:['ads_read','ads_mcp_management','ads_management']}]){
    await withProtectedFixture(async({resolver,calls,data})=>{
      Object.assign(data,change);
      await assert.rejects(resolver.resolve(binding,new AbortController().signal));
      assert.deepEqual(calls,['debug_token']);
    });
  }
});
test('retired local record and wrong envelope binding do not fall back to another token',async()=>{
  await withProtectedFixture(async({resolver,calls,file})=>{
    await assert.rejects(resolver.resolve({...binding,accountId:'2'},new AbortController().signal));
    assert.equal(calls.length,0);
    await unlink(file);
    await assert.rejects(resolver.resolve(binding,new AbortController().signal));
    assert.equal(calls.length,0);
  });
});
test('replacement-reference binding preserves disabled state and checks expected old ref',async()=>{
  const names=['DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_META_TRANSPORT','DAILY_SYNC_META_CREDENTIAL_REF','DAILY_SYNC_ALLOWED_ACCOUNTS'];
  const saved=names.map(name=>[name,process.env[name]] as const);
  try{
    process.env.DAILY_SYNC_FEATURE_ENABLED='true';process.env.DAILY_SYNC_META_TRANSPORT='MCP';
    process.env.DAILY_SYNC_META_CREDENTIAL_REF=binding.credentialRef;
    process.env.DAILY_SYNC_ALLOWED_ACCOUNTS=JSON.stringify([accountKey('META',binding.accountId,'')]);
    const oldRef='vault://meta/00000000-0000-4000-8000-000000000013';
    const connection={provider:'META',externalAccountId:binding.accountId,shopKey:'',
      credentialRef:oldRef,credentialExpiresAt:new Date(+now+25*DAY),enabled:false,accessState:'REAUTH_REQUIRED'};
    const args:unknown[][]=[];
    const service=new MetaCredentialBindingService({sourceConnection:{findUnique:async()=>connection}} as any,
      {bindStaticCredentialRef:async(...values:unknown[])=>{args.push(values);return {enabled:false};}} as any,
      {resolve:async()=>({...resolved,expiresAt:new Date(Date.now()+30*DAY)})});
    const result=await service.bindConfiguredAuth(binding.connectionId,'synthetic-actor');
    assert.equal(result.enabled,false);assert.equal(connection.enabled,false);assert.equal(args.length,1);
    assert.equal(args[0][2],binding.credentialRef);assert.equal(args[0][3],oldRef);
    connection.credentialRef=binding.credentialRef;
    await assert.rejects(service.bindConfiguredAuth(binding.connectionId,'synthetic-actor'));
    assert.equal(args.length,1);
  }finally{for(const[name,value]of saved)value===undefined?delete process.env[name]:process.env[name]=value;}
});
