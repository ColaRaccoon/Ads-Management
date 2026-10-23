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
}catch(error){Object.assign(result,safeDatabaseCodes(error));}
finally{input='';await db?.$disconnect().catch(()=>{});process.stdout.write(JSON.stringify(result));}
