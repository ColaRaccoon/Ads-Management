// Target-only read diagnostics. No source exports, credentials, policy writes or provider calls.
import {PrismaClient,Prisma} from '@prisma/client';
import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configurationStateDigest} from '../../../apps/api/src/daily-sync/cafe24-live-configuration.ts';
const types=new Set(['PrismaClientKnownRequestError','PrismaClientUnknownRequestError','PrismaClientInitializationError','PrismaClientValidationError']);
const states=['40001','40P01','42501','42703','42P01','42P05','26000','0A000','P0001','22023','55000','34000','23514','57014','25001','22P02'];
export function safeBootstrapDiagnostic(error) {
 const message=typeof error?.message==='string'?error.message:'';
 return {errorType:types.has(error?.name)?error.name:'UNCLASSIFIED',
  prismaCode:typeof error?.code==='string'&&/^P\d{4}$/.test(error.code)?error.code:null,
  messageMatchedEnums:states.filter(code=>new RegExp(`\\b${code}\\b`).test(message))};
}
export async function diagnoseBootstrapTransactions(input,factory=url=>new PrismaClient({datasourceUrl:url})) {
 const db=factory(assertBusinessDatabaseTarget(input));const probes=[];
 try {
  for(const [probe,isolationLevel] of [['SERIALIZABLE_READONLY',Prisma.TransactionIsolationLevel.Serializable],['READCOMMITTED_READONLY',Prisma.TransactionIsolationLevel.ReadCommitted]]) {
   let stage='BEGIN';
   try {
    await db.$transaction(async tx=>{
     stage='SET_READONLY';await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
     stage='EXACT_IDENTITY_QUERY';
     const rows=await tx.$queryRawUnsafe("SELECT current_user::text AS role,current_schema()::text AS schema,(SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads') AS tables");
     if(rows.length!==1 || rows[0].role!=='phase08_runtime' || rows[0].schema!=='phase08_meta_ads' || Number(rows[0].tables)!==68)throw new Error('IDENTITY');
    },{timeout:20000,maxWait:2000,isolationLevel});
    probes.push({probe,state:'PASS'});
   } catch(error){probes.push({probe,state:'FAIL',stage,...safeBootstrapDiagnostic(error)});}
  }
  let stage='BEGIN';let pair=null;
  try {
   await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const connectionId='0c35defe-45fc-4a54-bc79-704df7bca5b1';
    stage='SOURCE_READ';const connection=await tx.sourceConnection.findUnique({where:{id:connectionId}});
    if(!connection || connection.provider!=='CAFE24' || connection.enabled || connection.accessState!=='READY')throw new Error('IDENTITY');
    stage='ACTOR_READ';const actor=await tx.appUser.findMany({where:{role:'SUPER_ADMIN',isActive:true,inviteStatus:'ACTIVE'},take:2});
    if(actor.length!==1)throw new Error('IDENTITY');
    stage='FRESH_COUNTS';const counts=await Promise.all([tx.sourcePolicy.count({where:{connectionId}}),tx.syncRun.count({where:{connectionId}}),tx.syncLease.count({where:{connectionId}}),tx.sourceCoverage.count({where:{connectionId}})]);
    if(counts.some(count=>count!==0))throw new Error('IDENTITY');
    stage='CONFIGURATION_READ';await configurationStateDigest(tx);
    stage='CREDENTIAL_READ';pair=await tx.sourceCredential.findMany({where:{connectionId}});
    if(pair.length!==2)throw new Error('IDENTITY');
    stage='OAUTH_METADATA_READ';const attempts=await tx.cafe24OauthAttempt.findMany({where:{connectionId,consumedAt:{not:null}},select:{actorUserId:true,consumedAt:true,expiresAt:true},take:2});
    if(attempts.length!==1)throw new Error('IDENTITY');
   },{timeout:20000,maxWait:2000,isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
   probes.push({probe:'SERIALIZABLE_BOOTSTRAP_READS',state:'PASS'});
  } catch(error){probes.push({probe:'SERIALIZABLE_BOOTSTRAP_READS',state:'FAIL',stage,...safeBootstrapDiagnostic(error)});}
  finally {if(pair)for(const row of pair)for(const key of ['ciphertext','iv','authTag'])if(row[key]?.fill)row[key].fill(0);pair=null;}
  return {state:'PHASE08_BOOTSTRAP_TRANSACTION_DIAGNOSTIC',probes,targetWrites:0,operatingReads:0,providerRequests:0};
 } finally {await db.$disconnect();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 let raw='';
 try {for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw new Error('input');}
  const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(await diagnoseBootstrapTransactions(input)));
 } catch {process.stdout.write('{"state":"PHASE08_BOOTSTRAP_TRANSACTION_DIAGNOSTIC_UNAVAILABLE"}');process.exitCode=1;}
 finally {raw='';}
}
