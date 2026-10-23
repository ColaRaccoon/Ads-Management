import {PrismaClient} from '@prisma/client';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const file='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance/deploy/cloud/certs/supabase-prod-ca-2021.crt';
const sha=x=>createHash('sha256').update(x).digest('hex');
const out={kind:'ONEOFF_PRISMA_CLIENT_TRUST_DIAGNOSTIC',at:new Date().toISOString(),results:[],providerRequests:0,businessQueries:0,remoteMutations:0,rawValuesReturned:0};
let input='';
try{
 if(process.env.CAFE08_ONEOFF_PARENT!=='20261021-ROOT'||sha(readFileSync(file))!=='1dcaafbf6fda7f21e34ff35825c1a1354408ea11e5839157e690af851c73453a')throw Error();
 for await(const c of process.stdin){input+=c;if(Buffer.byteLength(input)>32768)throw Error();}
 const p=JSON.parse(input);input='';const base=new URL(p.databaseUrl);
 if(base.hostname!=='aws-0-ap-northeast-2.pooler.supabase.com'||base.port!=='5432'||decodeURIComponent(base.username)!=='phase08_runtime.ehnfrrmbkvlsbpvqcvkr'||base.searchParams.get('sslaccept')!=='strict'||base.searchParams.get('sslmode')!=='require')throw Error();
 for(const usePinnedCa of [false,true]){
  const url=new URL(base);if(usePinnedCa)url.searchParams.set('sslcert',file);url.searchParams.set('connect_timeout','10');
  const db=new PrismaClient({datasourceUrl:url.toString(),log:[]});let connected=false,code=null;
  try{await db.$connect();connected=true;}catch(e){code=/^P[0-9]{4}$/.test(e?.errorCode??e?.code??'')?(e.errorCode??e.code):'OTHER_SUPPRESSED';}finally{await db.$disconnect().catch(()=>{});}
  out.results.push({usePinnedCa,connected,safeCode:code});
 }
 process.stdout.write(JSON.stringify(out));
}catch{process.stdout.write(JSON.stringify({kind:out.kind,status:'FAIL',rawErrorSuppressed:true,rawValuesReturned:0}));process.exitCode=1;}finally{input='';}
