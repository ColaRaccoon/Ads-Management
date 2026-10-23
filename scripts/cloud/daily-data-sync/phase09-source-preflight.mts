import {PrismaClient} from '@prisma/client';
import {databaseUrlWithConnectionLimit} from '../../../apps/api/src/common/prisma.service';
let client:PrismaClient|undefined;
let stage='INPUT';
try {
  let input='';for await(const part of process.stdin) input+=part;
  const value=JSON.parse(input);input='';
  stage='URL';const url=new URL(value.url);
  stage='TARGET';
  if(value.projectId!=='d72f4256-8632-437a-9dae-9b5d96736fc7'||value.serviceId!=='ef46528f-4b59-4ee6-9d9c-b0852b5a9274'||!url.hostname.endsWith('.proxy.rlwy.net'))throw Error('target');
  stage='CLIENT';client=new PrismaClient({datasourceUrl:databaseUrlWithConnectionLimit(url.toString(),'1')});
  stage='READONLY_QUERY';
  const result=await client.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return tx.$queryRawUnsafe("SELECT current_database() AS database,current_schema() AS schema,current_setting('transaction_read_only') AS read_only,(SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS public_tables,(SELECT count(*)::int FROM public.cafe24_order_lines WHERE source::text='API' AND is_current) AS cafe_api_lines");
  });
  console.log(JSON.stringify({kind:'PHASE09_CAFE_SOURCE_READONLY_PREFLIGHT',result,providerRequests:0,databaseWrites:0}));
}catch{console.log(JSON.stringify({kind:'PHASE09_CAFE_SOURCE_PREFLIGHT_FAILED',stage,rawErrorSuppressed:true}));process.exitCode=1;}
finally{await client?.$disconnect();}
