import {PrismaClient} from '@prisma/client';
import {safeDatabaseCodes,DATABASE_CERTIFICATE_PATH,verifyDatabaseCertificate} from './phase10-cafe-oneoff-executor-v2-20261021.mjs';
let input='',db;
const result={kind:'ONEOFF_PRISMA_PINNED_CA_DIAGNOSTIC',at:new Date().toISOString(),connected:false,providerRequests:0,businessQueries:0,remoteMutations:0,rawValuesReturned:0};
try{
 if(process.env.CAFE08_ONEOFF_PARENT!=='20261021-ROOT')throw Error();verifyDatabaseCertificate();
 for await(const c of process.stdin){input+=c;if(Buffer.byteLength(input)>32768)throw Error();}
 const p=JSON.parse(input);input='';const u=new URL(p.databaseUrl);
 if(u.hostname!=='aws-0-ap-northeast-2.pooler.supabase.com'||decodeURIComponent(u.username)!=='phase08_runtime.ehnfrrmbkvlsbpvqcvkr'||u.searchParams.get('sslaccept')!=='strict'||u.searchParams.get('sslmode')!=='require')throw Error();
 u.searchParams.set('sslcert',DATABASE_CERTIFICATE_PATH);u.searchParams.set('connect_timeout','10');
 db=new PrismaClient({datasourceUrl:u.toString(),log:[]});await db.$connect();result.connected=true;
}catch(error){Object.assign(result,safeDatabaseCodes(error)); const m=typeof error?.message==='string'?error.message:''; result.knownFlags={notPermittedLogin:/not permitted to log ?in/i.test(m),passwordAuthentication:/password authentication/i.test(m),tenantNotFound:/tenant or user not found/i.test(m),tlsConnection:/TLS connection|TLS error/i.test(m),certificate:/certificate/i.test(m),fileMissing:/No such file|cannot find|not found|os error 2/i.test(m),fileOpening:/opening|read.*file/i.test(m),permission:/permission denied|insufficient privilege/i.test(m),sasl:/SASL|SCRAM/i.test(m),unreachable:/reach database|connection refused|timed out/i.test(m),serverClosed:/closed.*connection|connection.*closed/i.test(m),tenant:/tenant/i.test(m),user:/user/i.test(m),role:/role/i.test(m),engine:/Query Engine|query_engine/i.test(m),filesystem:/file|directory|path|No such/i.test(m),ssl:/ssl/i.test(m),osError:/os error/i.test(m),login:/login|log in/i.test(m),unknown:/unknown/i.test(m)};}
finally{input='';await db?.$disconnect().catch(()=>{});process.stdout.write(JSON.stringify(result));}
