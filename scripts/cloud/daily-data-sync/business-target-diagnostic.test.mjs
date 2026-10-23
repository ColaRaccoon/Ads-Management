import test from 'node:test';
import assert from 'node:assert/strict';
import {Prisma} from '@prisma/client';
import {readFileSync} from 'node:fs';
import {businessFailureDiagnostic, diagnoseBusinessTarget, assertBusinessDatabaseTarget, validateBusinessCertificate, businessCertificatePath} from './seed-isolated-business-config.mjs';
const input={projectRef:'ehnfrrmbkvlsbpvqcvkr',freshVerified:true,databaseUrl:'postgresql://phase08_runtime.ehnfrrmbkvlsbpvqcvkr:SYNTHETIC@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=phase08_meta_ads&sslmode=verify-full&connection_limit=3&pool_timeout=10&connect_timeout=10'};
test('local public CA is fixed and hash checked; strict TLS cannot be relaxed by caller parameters',()=>{
  const url=new URL(assertBusinessDatabaseTarget(input));
  assert.equal(url.searchParams.get('sslmode'),'require');assert.equal(url.searchParams.get('sslaccept'),'strict');
  if(process.platform==='win32') assert.equal(url.searchParams.get('sslcert'),businessCertificatePath);
  assert.equal(url.searchParams.has('sslrootcert'),false);
  assert.equal(validateBusinessCertificate(),businessCertificatePath);
  for(const suffix of ['&sslrootcert=C:/FOREIGN.crt','&sslcert=C:/FOREIGN.crt','&sslaccept=accept_invalid_certs'])assert.throws(()=>assertBusinessDatabaseTarget({...input,databaseUrl:input.databaseUrl+suffix}));
  assert.throws(()=>validateBusinessCertificate('C:/FOREIGN.crt',{lstatSync:()=>{throw new Error('MUST_NOT_READ');}}),/TARGET_CERTIFICATE_REJECTED/);
  const metadata={isFile:()=>true,isSymbolicLink:()=>false,size:1000};
  assert.throws(()=>validateBusinessCertificate(businessCertificatePath,{lstatSync:()=>metadata,readFileSync:()=>readFileSync(businessCertificatePath,'utf8')+'x'}),/TARGET_CERTIFICATE_REJECTED/);
  assert.throws(()=>validateBusinessCertificate(businessCertificatePath,{lstatSync:()=>({...metadata,isSymbolicLink:()=>true}),readFileSync:()=>{throw new Error('MUST_NOT_READ');}}),/TARGET_CERTIFICATE_REJECTED/);
});
test('actual Prisma initialization error exposes only fixed errorCode/type, suppressing raw details',()=>{
  const error=new Prisma.PrismaClientInitializationError('SYNTHETIC_PRIVATE_MESSAGE','6.11.1','P1011');
  const result=businessFailureDiagnostic(error,'RUNTIME_IDENTITY');
  assert.equal(result.code,'P1011');assert.equal(result.errorType,'PrismaClientInitializationError');
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_MESSAGE'),false);
  for(const value of [ ['P1011','SYNTHETIC_PRIVATE'],{value:'P1011'},123,'P1011\nSYNTHETIC_PRIVATE']) {
    const result=businessFailureDiagnostic({code:value,errorCode:value,name:value});
    assert.equal(result.code,'UNCLASSIFIED');assert.equal(result.errorType,'UNCLASSIFIED');
  }
});
test('target-only diagnosis verifies runtime identity inside read-only transaction and never requests configuration',async()=>{
  let calls=[],disconnected=0;
  const db={$transaction:async fn=>fn({$executeRawUnsafe:async sql=>calls.push(sql),$queryRawUnsafe:async sql=>{calls.push(sql);return [{database:'postgres',role:'phase08_runtime',readonly:'on'}];}}),$disconnect:async()=>{disconnected++;}};
  const result=await diagnoseBusinessTarget(input,()=>db);
  assert.equal(result.state,'PHASE08_BUSINESS_TARGET_READONLY_VERIFIED');
  assert.equal(calls.length,2);assert.equal(calls[0],'SET TRANSACTION READ ONLY');assert.match(calls[1],/^SELECT /);
  assert.equal(disconnected,1);assert.equal(result.targetWrites,0);assert.equal(result.operatingReads,0);
});
test('wrong target cannot create a client; wrong runtime identity disconnects without writing',async()=>{
  let created=0,disconnected=0;
  await assert.rejects(diagnoseBusinessTarget({...input,projectRef:'iygjmosbelbosfxidqxv'},()=>{created++;}));assert.equal(created,0);
  await assert.rejects(diagnoseBusinessTarget(input,()=>({$transaction:async fn=>fn({$executeRawUnsafe:async()=>{},$queryRawUnsafe:async()=>[{database:'postgres',role:'postgres',readonly:'on'}]}),$disconnect:async()=>{disconnected++;}})));
  assert.equal(disconnected,1);
});
