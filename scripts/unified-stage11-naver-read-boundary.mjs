// Isolated PG17 rehearsal: compare the original component savepoints with one
// READ ONLY/RR day savepoint, including SQL denial recovery and row limits.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {PrismaClient,Prisma} from '@prisma/client';
import {naverQueries,readNaverProjection,readNaverDayProjections,NAVER_READ_TABLES} from '../apps/api/src/unified-performance/adapters/naver-reader.ts';
const runtime=resolve(process.env.LOCALAPPDATA,'UnifiedPerformanceStage02'),require=createRequire(import.meta.url),{Client}=require(resolve(runtime,'node_modules/pg'));
const bin=resolve(runtime,'node_modules/@embedded-postgres/windows-x64/native/bin'),root=resolve(runtime,'stage11-naver-reader-'+randomUUID()),data=resolve(root,'data');mkdirSync(root,{recursive:true});
const port=55464,database='unified_stage11_naver_reader',scope='78f8cb08-ffe3-481a-94d7-be87ae93ed79',date='2026-05-21';
const run=(file,args,options={})=>{const r=spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:60000,...options});assert.equal(r.status,0,'LOCAL_POSTGRES_COMMAND_FAILED');return r;};
let started=false,db,worker;let commands=[];
const evidence={stage:11,kind:'LOCAL_PG17_NAVER_READ_BOUNDARY_EQUIVALENCE',remoteWrites:0,status:'RUNNING',cases:[]};
try{
 run(resolve(bin,'initdb.exe'),['-D',data,'-U','fixture_owner','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C']);
 run(resolve(bin,'pg_ctl.exe'),['-D',data,'-l',resolve(root,'pg.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],{stdio:'ignore'});started=true;
 db=new Client({host:'127.0.0.1',port,user:'fixture_owner',database:'postgres'});await db.connect();
 const identity=(await db.query("SELECT inet_server_addr()::text host,current_setting('server_version_num') version")).rows[0];assert.match(identity.host,/^127\.0\.0\.1/);assert.match(identity.version,/^17/);
 await db.query(`CREATE DATABASE ${database}`);await db.end();db=new Client({host:'127.0.0.1',port,user:'fixture_owner',database});await db.connect();
 await db.query("CREATE ROLE naver_fixture_reader LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; GRANT USAGE ON SCHEMA public TO naver_fixture_reader; SET TIME ZONE 'Asia/Seoul'");
 for(const table of NAVER_READ_TABLES){assert(/^[a-z_]+$/.test(table));await db.query(`CREATE TABLE public.${table}(id text PRIMARY KEY,payload jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT '2026-05-21T03:00:00+09:00'); GRANT SELECT ON public.${table} TO naver_fixture_reader`);}
 const insert=async(table,id,payload)=>db.query(`INSERT INTO public.${table}(id,payload) VALUES($1,$2)`,[id,JSON.stringify(payload)]);
 await insert('stores',scope,{platformType:'NAVER_SMARTSTORE',deliveryUnitCost:'3000',customerSecret:'DO_NOT_PROJECT'});
 await insert('order_items','one',{storeId:scope,paymentDate:date,rawProductName:'풀업바',orderSourceSignatureId:'signature-one',productId:'product-one',quantity:'2',productPaymentAmount:'9007199254740993.123456',updatedAt:'unqualified timestamp',customerSecret:'DO_NOT_PROJECT'});
 await insert('order_source_signatures','signature-one',{storeId:scope,rawProductNameSnapshot:'풀업바',rawOptionInfoSnapshot:'단품',customerSecret:'DO_NOT_PROJECT'});
 await insert('order_source_signatures','unreferenced-signature',{storeId:scope,rawProductNameSnapshot:'DO_NOT_READ'});
 await insert('products','product-one',{storeId:scope,productName:'풀업바'});
 await insert('order_items','other-store',{storeId:'other-store',paymentDate:date,rawProductName:'DO_NOT_READ',quantity:'7'});
 await insert('canonical_sales_units','unit',{storeId:scope,displayName:'풀업바',isActive:true,matchAliases:['풀업바',{secret:'DO_NOT_PROJECT'}]});
 await db.query('CREATE TABLE public.writer_probe(id int); GRANT UPDATE ON public.writer_probe TO naver_fixture_reader');
 const url=`postgresql://naver_fixture_reader@127.0.0.1:${port}/${database}?schema=public`;const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55464');
 worker=new PrismaClient({datasourceUrl:url,log:[{emit:'event',level:'query'}]});worker.$on('query',event=>commands.push(event.query.trim().split(/\s+/)[0]));
 const queries=naverQueries(scope,date),keys=Object.keys(queries);
 async function read(shared){return worker.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');commands=[];
  let result;
  if(shared)result=await readNaverDayProjections(tx,naverQueries(scope,date,undefined,true),{scope,date});
  else{const raw={},errors={};for(const key of keys){errors[key]=[];raw[key]=await readNaverProjection(tx,queries[key],key,errors[key]);}result={raw,errors};}
  return{result,commands:[...commands]};
 },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});}
 async function compare(label){const old=await read(false),now=await read(true);assert.deepEqual(now.result,old.result);
  assert(!JSON.stringify(now.result).includes('DO_NOT_'));evidence.cases.push({label,identical:true,oldStatements:old.commands.length,newStatements:now.commands.length,
   selectStatements:now.commands.filter(x=>x==='SELECT').length,errorComponents:Object.entries(now.result.errors).filter(([,x])=>x.length).map(([k])=>k),
   projectionHash:createHash('sha256').update(JSON.stringify(now.result)).digest('hex')});return now.result;}
 const normal=await compare('normal exact strings, booleans, timestamps and alias arrays');assert.equal(normal.raw.order_items.length,1);assert.equal(normal.raw.order_items[0].productPaymentAmount,'9007199254740993.123456');
 assert.deepEqual(normal.raw.canonical_sales_units[0].matchAliases,['풀업바']);assert.equal(evidence.cases[0].oldStatements,keys.length*3);assert.equal(evidence.cases[0].newStatements,keys.length+2);
 await db.query('REVOKE SELECT ON public.ad_campaign_daily_costs,public.sales_unit_cost_snapshot_entries FROM naver_fixture_reader');
 const denied=await compare('two SQL permission errors recover without losing readable sales');assert(denied.errors.ad_campaign_daily_costs.length);assert(denied.errors.sales_unit_cost_snapshot_entries.length);assert.equal(denied.raw.order_items.length,1);
 await db.query('GRANT SELECT ON public.ad_campaign_daily_costs,public.sales_unit_cost_snapshot_entries TO naver_fixture_reader');
 await insert('order_items','numeric-reference',{storeId:scope,paymentDate:date,orderSourceSignatureId:42,productId:43,quantity:'1'});
 await insert('order_source_signatures','42',{storeId:scope,rawProductNameSnapshot:'numeric fixture'});
 await insert('products','43',{storeId:scope,productName:'numeric fixture'});
 await insert('order_items','complex-reference',{storeId:scope,paymentDate:date,orderSourceSignatureId:{customerSecret:'DO_NOT_PROJECT'},quantity:'1'});
 await compare('malformed reference types retain original SQL lookup semantics without exposing payload values');
 await db.query('DELETE FROM public.order_items');
 await db.query(`INSERT INTO public.order_items(id,payload) SELECT 'bound-'||i,jsonb_build_object('storeId',$1::text,'paymentDate',$2::text,'quantity','1') FROM generate_series(1,10001) i`,[scope,date]);
 const bounded=await compare('10001 rows retain the original component bound');assert.equal(bounded.raw.order_items.length,0);assert(bounded.errors.order_items.length);
 await assert.rejects(worker.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await readNaverDayProjections(tx,queries);await tx.$executeRawUnsafe('UPDATE public.writer_probe SET id=0 WHERE false');}),error=>/read-only transaction/.test(error.message));
 evidence.readOnlyEnforced=true;evidence.status='PASS';
}catch(error){evidence.status='FAIL';evidence.errorClass=error.constructor?.name;evidence.message=error.message;process.exitCode=1;
}finally{await worker?.$disconnect();await db?.end();if(started){const stop=spawnSync(resolve(bin,'pg_ctl.exe'),['-D',data,'-m','fast','-w','stop'],{windowsHide:true,encoding:'utf8',timeout:30000});evidence.stopExit=stop.status;if(stop.status!==0){evidence.status='FAIL';process.exitCode=1;}}
 writeFileSync('docs/product-performance/research/11-naver-read-boundary-fixture.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));}
