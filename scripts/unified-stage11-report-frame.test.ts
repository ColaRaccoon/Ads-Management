import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
import {Prisma,PrismaClient} from "@prisma/client";
import type {PrismaService} from "../apps/api/src/common/prisma.service";
import {UnifiedManagementRepository} from "../apps/api/src/unified-performance/management.repository";
import {UnifiedReportRepository,missingCoverage} from "../apps/api/src/unified-performance/report.repository";
import {LegacyUnifiedReportRepository} from "./unified-stage11-report-oracle";
import {UnifiedReportService} from "../apps/api/src/unified-performance/report.service";
import type {UnifiedAggregationRepository} from "../apps/api/src/unified-performance/aggregation.repository";
import {parseReportQuery} from "../apps/api/src/unified-performance/report-query";
import {CONTRACT_VERSION,PLATFORMS,type Platform} from "../apps/api/src/unified-performance/types";
import type {ReportFact} from "../apps/api/src/unified-performance/report-contract";

const port=55464,database="unified_stage11_frame";
const url=(role:string)=>`postgresql://${role}@127.0.0.1:${port}/${database}?schema=meta_ads&connection_limit=1`;
const scopes:Record<Platform,string>={META:"11111111-1111-4111-8111-111111111111",GOOGLE:"11111111-1111-4111-8111-111111111112",CAFE24:"11111111-1111-4111-8111-111111111113",COUPANG:"LEGACY_COUPANG_SINGLE_UPLOAD",NAVER:"11111111-1111-4111-8111-111111111119"};
const actor={id:randomUUID(),permissions:["data.read" as const]};
const input={from:"2026-10-25",to:"2026-10-26",compareFrom:"2026-10-25",compareTo:"2026-10-25",productName:"정확제품"};
const canonical=(value:any):any=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;

test("report-only one-statement frame equals the previous Prisma reader under actual restricted PG17 login",{skip:!process.env.UNIFIED_STAGE11_FRAME_REPORT_URL},async t=>{
 assert.equal(process.env.UNIFIED_STAGE11_FRAME_OWNER_URL,url("stage11_frame_owner"));assert.equal(process.env.UNIFIED_STAGE11_FRAME_REPORT_URL,url("stage11_frame_report"));
 const owner=new PrismaClient({datasourceUrl:url("stage11_frame_owner")});
 const report=new PrismaClient({datasourceUrl:url("stage11_frame_report"),log:[{emit:"event",level:"query"}]});
 const statements:string[]=[];report.$on("query",event=>statements.push(event.query));
 const management=new UnifiedManagementRepository(report as unknown as PrismaService);
 const next=new UnifiedReportRepository(management),old=new LegacyUnifiedReportRepository(management);
 const service=new UnifiedReportService(next,{} as UnifiedAggregationRepository),legacyService=new UnifiedReportService(old as unknown as UnifiedReportRepository,{} as UnifiedAggregationRepository);
 const observed:any={stage:11,synthetic:true,remoteWrites:0,checks:[],equivalenceCases:0};
 try{
  const identity=await report.$queryRaw<Array<{usr:string;db:string;host:string;admin:boolean;owns:bigint}>>`SELECT current_user usr,current_database() db,inet_server_addr()::text host,rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole admin,(SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
  assert.equal(identity[0].usr,"stage11_frame_report");assert.equal(identity[0].db,database);assert.match(identity[0].host,/^127\.0\.0\.1/);assert.equal(identity[0].admin,false);assert.equal(identity[0].owns,0n);
  await report.$executeRawUnsafe("SET TIME ZONE 'Asia/Seoul'");
  const timezone=await report.$queryRaw<Array<{zone:string}>>`SELECT current_setting('TimeZone') zone`;
  assert.equal(timezone[0].zone,"Asia/Seoul");observed.sessionTimeZone=timezone[0].zone;
  await assert.rejects(report.$queryRaw`SELECT credential_ref FROM meta_ads.source_connections LIMIT 0`,/permission denied/);
  await assert.rejects(report.$queryRaw`SELECT * FROM meta_ads.cafe24_order_lines LIMIT 0`,/permission denied/);
  await assert.rejects(report.$executeRaw`DELETE FROM meta_ads.unified_daily_facts WHERE false`,/permission denied/);
  const product=await owner.unifiedProduct.create({data:{canonicalName:"정확제품",normalizedName:"정확제품"}});
  await owner.unifiedRule.create({data:{kind:"NAME",productId:product.id,identityKey:"a".repeat(64),validFrom:new Date("2024-02-29"),validTo:new Date("2026-12-31"),payload:{terms:["정확제품"],nested:{valid_from:"do-not-convert",amount:"9007199254740993.123456"}}}});
  for(const platform of ["META","GOOGLE","CAFE24"] as const)await owner.sourceConnection.create({data:{id:scopes[platform],provider:platform,externalAccountId:`private-${platform}`,displayName:`합성 ${platform}`,currencyCode:"KRW",timeZone:"Asia/Seoul",credentialRef:"private-sentinel"}});
  async function seed(platform:Platform,date:string,amount="9007199254740993.123456",zero=false){
   const run=await owner.unifiedAggregationRun.create({data:{sourceSystem:platform,platform,scopeKey:scopes[platform],businessDate:new Date(date),contractVersion:CONTRACT_VERSION,versions:{calculationVersion:"unified-report-v1",nameRuleVersion:"n1"},readSnapshotId:"fixture",sourceWatermarks:{},controlTotals:[],issues:[]}});
   const sale=["NAVER","COUPANG","CAFE24"].includes(platform),quality={isEstimate:platform==="NAVER",confidence:platform==="NAVER"?"ESTIMATED" as const:"SOURCE_REPORTED" as const,issues:[]};
   const partial=platform==="CAFE24"&&date==="2026-10-25";
   const payload:ReportFact={component:sale?"SALE":"AD_SPEND",factKey:"exact",productName:"정확제품",saleUnitName:sale?"단품":null,amountKrw:amount,completeAmountKrw:amount,profitBeforeAds:sale&&!partial?"100.000001":null,completeProfitBeforeAds:sale&&!partial?"100.000001":null,originalAmount:amount,currency:"KRW",quantity:"1.000000",attribution:"DIRECT",medium:sale?null:platform,marketplace:sale?platform:null,commonKind:null,rowsCount:1,quality};
   if(!zero)await owner.unifiedDailyFact.create({data:{runId:run.id,component:payload.component,factKey:"exact",productName:payload.productName,saleUnitName:payload.saleUnitName,amountKrw:amount,originalAmount:amount,quantity:"1",attribution:"DIRECT",payload:payload as unknown as Prisma.InputJsonValue}});
   for(const initial of missingCoverage({platform,scopeKey:scopes[platform],label:"fixture"},date)){
    const details={...initial,collectionState:partial&&initial.component==="DIRECT_COST"?"PARTIAL":"COMPLETE",rowsPresent:zero?0:1,zeroConfirmed:zero,mappedRows:zero?0:1,sourceAsOf:`${date}T12:00:00Z`,missingCostRows:partial?1:0,quality};
    await owner.unifiedSourceCoverage.create({data:{runId:run.id,component:initial.component,participation:"INCLUDED",collectionState:details.collectionState,rowsPresent:details.rowsPresent,zeroConfirmed:zero,sourceAsOf:new Date(details.sourceAsOf),isEstimate:quality.isEstimate,details:details as unknown as Prisma.InputJsonValue}});
   }
   await owner.unifiedAggregationRun.update({where:{id:run.id},data:{status:"READY",completedAt:new Date("2026-10-27T00:00:00Z")}});
   await owner.unifiedSourcePublication.upsert({where:{sourceSystem_platform_scopeKey_businessDate:{sourceSystem:platform,platform,scopeKey:scopes[platform],businessDate:new Date(date)}},create:{sourceSystem:platform,platform,scopeKey:scopes[platform],businessDate:new Date(date),runId:run.id},update:{runId:run.id,revision:{increment:1}}});
   await owner.unifiedAggregationRun.update({where:{id:run.id},data:{status:"PUBLISHED",publishedAt:new Date("2026-10-27T00:00:00Z")}});
   return run.id;
  }
  for(const platform of PLATFORMS)for(const date of ["2026-10-25","2026-10-26"])if(!(platform==="NAVER"&&date==="2026-10-25"))await seed(platform,date);
  await seed("CAFE24","2026-10-24","0.000000",true);
  await owner.unifiedAggregationRun.create({data:{sourceSystem:"META",platform:"META",scopeKey:scopes.META,businessDate:new Date("2026-10-26"),status:"FAILED",contractVersion:CONTRACT_VERSION,versions:{},readSnapshotId:"failed",sourceWatermarks:{},controlTotals:[],issues:["SYNTHETIC"],startedAt:new Date("2026-10-28"),completedAt:new Date("2026-10-28")}});
  await t.test("32 platform selections preserve Dates, nulls, exact strings, partial/stale and endpoint/cursor semantics",async()=>{
   for(let mask=0;mask<32;mask++){
    const selected=PLATFORMS.filter((_,index)=>mask&(1<<index)),q=parseReportQuery({...input,platforms:selected});
    const before=await old.snapshot(q),after=await next.snapshot(q);
    assert.deepEqual(canonical(after),canonical(before),`snapshot mask${mask}`);observed.equivalenceCases++;
    assert(after.products[0].createdAt instanceof Date);assert(after.rules[0].validFrom instanceof Date);assert.equal(after.rules[0].validFrom.toISOString(),"2024-02-29T00:00:00.000Z");assert.equal(after.rules[0].validTo?.toISOString(),"2026-12-31T00:00:00.000Z");
    for(const kind of ["summary","timeseries","diagnostics","options","relationships"] as const){
     const a=await legacyService.read(kind,{...input,platforms:selected},actor),b=await service.read(kind,{...input,platforms:selected},actor);
     assert.deepEqual(canonical(b),canonical(a),`${kind} mask${mask}`);observed.equivalenceCases++;
    }
   }
   const snapshot=await next.snapshot(parseReportQuery({...input,platforms:["META","CAFE24"]}));
   assert(snapshot.coverage.some(row=>row.collectionState==="STALE"));assert(snapshot.coverage.some(row=>row.collectionState==="PARTIAL"));assert.equal(snapshot.facts[0].amountKrw,"9007199254740993.123456");
   const first=await service.read("diagnostics",{...input,platforms:["CAFE24"],limit:1},actor) as any;assert(first.nextCursor);
   const second=await service.read("diagnostics",{...input,platforms:["CAFE24"],limit:1,cursor:first.nextCursor},actor) as any;assert.equal(second.items.length,1);assert.notDeepEqual(first.items,second.items);
   const paged:any[]=[];let cursor:string|undefined;
   do{const page=await service.read("diagnostics",{...input,platforms:["CAFE24"],limit:1,...(cursor?{cursor}:{})},actor) as any;assert.equal(page.snapshotHash,first.snapshotHash);paged.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);
   const keys=paged.map(row=>JSON.stringify([row.platform,row.scopeKey,row.date,row.component]));assert.equal(new Set(keys).size,paged.length);
   const full=await legacyService.read("diagnostics",{...input,platforms:["CAFE24"]},actor) as any;assert.deepEqual(canonical(paged),canonical(full.items));
   await assert.rejects(next.snapshot(parseReportQuery({...input,platforms:["CAFE24"],scopeKeys:["forbidden"]})),/허용되지/);
   const zeroInput={...input,from:"2026-10-24",to:"2026-10-24",compareFrom:"2026-10-24",compareTo:"2026-10-24",platforms:["CAFE24"]};
   const zero=await service.read("summary",zeroInput,actor);assert.equal(zero.completeTotals.revenue,"0.000000");assert.deepEqual(canonical(zero),canonical(await legacyService.read("summary",zeroInput,actor)));
  });
  await t.test("one data statement plus the same read-only RR transaction; no source/credential access",async()=>{
   const q=parseReportQuery({...input,platforms:["META","CAFE24"]});statements.length=0;await old.snapshot(q);const oldStatements=statements.slice();statements.length=0;await next.snapshot(q);const newStatements=statements.slice();
   assert.equal(newStatements.filter(sql=>sql.startsWith("WITH")).length,1);assert(newStatements.some(sql=>/SET TRANSACTION READ ONLY/.test(sql)));assert(newStatements.length<oldStatements.length);
   assert(!newStatements.some(sql=>/credential_ref|cafe24_order_lines|public\.order_items/.test(sql)));observed.statementCounts={old:oldStatements.length,next:newStatements.length,newDataStatements:1};
  });
  await t.test("RLS hidden publications stay hidden and empty/forbidden account scopes retain their meaning",async()=>{
   await owner.$executeRawUnsafe("ALTER POLICY stage11_frame_read ON meta_ads.unified_source_publications USING(platform<>'META')");
   const q=parseReportQuery({...input,platforms:["META","CAFE24"]});assert.deepEqual(canonical(await next.snapshot(q)),canonical(await old.snapshot(q)));
   assert(!(await next.snapshot(q)).publications.some(row=>row.platform==="META"));
   const empty=await next.snapshot(parseReportQuery({...input,platforms:["META"],scopeKeys:[]}));assert.equal(empty.publications.length,0);
   await owner.$executeRawUnsafe("ALTER POLICY stage11_frame_read ON meta_ads.unified_source_publications USING(true)");
   await owner.$executeRawUnsafe("ALTER POLICY stage11_frame_read ON meta_ads.unified_aggregation_runs USING(platform<>'META')");
   await assert.rejects(old.snapshot(parseReportQuery({...input,platforms:["META"]})));
   await assert.rejects(next.snapshot(parseReportQuery({...input,platforms:["META"]})),(error:any)=>error.getResponse?.().code==="UNIFIED_REPORT_REBUILD_REQUIRED");
   await owner.$executeRawUnsafe("ALTER POLICY stage11_frame_read ON meta_ads.unified_aggregation_runs USING(true)");
  });
  await t.test("settled reads see fresh settings/publication and old cursors invalidate",async()=>{
   const request={...input,platforms:["CAFE24"],limit:1};const first=await service.read("diagnostics",request,actor) as any;
   const before=await next.snapshot(parseReportQuery(request));await owner.unifiedProduct.update({where:{id:product.id},data:{version:{increment:1}}});await seed("CAFE24","2026-10-26","123.000001");
   const after=await next.snapshot(parseReportQuery(request));assert.notEqual(before.snapshotHash,after.snapshotHash);assert.notEqual(before.versions.configurationVersion,after.versions.configurationVersion);
   assert(after.facts.some(row=>row.amountKrw==="123.000001"));await assert.rejects(service.read("diagnostics",{...request,cursor:first.nextCursor},actor),/발행 버전/);
   assert.deepEqual(canonical(after),canonical(await old.snapshot(parseReportQuery(request))));
  });
  await t.test("invalid stored report payload is rejected by both readers rather than emitted as a normal version",async()=>{
   const broken=await owner.unifiedAggregationRun.create({data:{sourceSystem:"CAFE24",platform:"CAFE24",scopeKey:scopes.CAFE24,businessDate:new Date("2026-10-22"),contractVersion:CONTRACT_VERSION,versions:{},readSnapshotId:"broken",sourceWatermarks:{},controlTotals:[],issues:[]}});
   await owner.unifiedDailyFact.create({data:{runId:broken.id,component:"SALE",factKey:"broken",productName:"정확제품",attribution:"DIRECT",payload:{}}});
   await owner.unifiedSourceCoverage.create({data:{runId:broken.id,component:"SALE",participation:"INCLUDED",collectionState:"COMPLETE",rowsPresent:1,isEstimate:false,details:{}}});
   await owner.unifiedAggregationRun.update({where:{id:broken.id},data:{status:"READY",completedAt:new Date()}});
   await owner.unifiedSourcePublication.create({data:{sourceSystem:"CAFE24",platform:"CAFE24",scopeKey:scopes.CAFE24,businessDate:new Date("2026-10-22"),runId:broken.id}});
   for(const repo of [old,next])await assert.rejects(repo.snapshot(parseReportQuery({...input,from:"2026-10-22",to:"2026-10-22",compareFrom:"2026-10-22",compareTo:"2026-10-22",platforms:["CAFE24"]})),(error:any)=>error.getResponse?.().code==="UNIFIED_REPORT_REBUILD_REQUIRED");
  });
  await t.test("catalog, connection, scope, partition and fact guards reject at their existing limits",async()=>{
   const expectBoth=async(request:any,code:string)=>{for(const repo of [old,next])await assert.rejects(repo.snapshot(parseReportQuery(request)),(error:any)=>error.getResponse?.().code===code);};
   await owner.$executeRawUnsafe("INSERT INTO meta_ads.unified_products(id,canonical_name,normalized_name,updated_at) SELECT gen_random_uuid(),'bound-'||n,'bound-'||n,now() FROM generate_series(1,10000) n");
   await expectBoth({...input,platforms:[]},"UNIFIED_CONFIGURATION_TOO_LARGE");await owner.$executeRawUnsafe("DELETE FROM meta_ads.unified_products WHERE canonical_name LIKE 'bound-%'");
   await owner.$executeRaw`INSERT INTO meta_ads.unified_rules(id,kind,product_id,identity_key,payload,valid_from,updated_at)
     SELECT gen_random_uuid(),'NAME',${product.id}::uuid,md5('bound-'||n)||md5('rule-'||n),'{}'::jsonb,'2026-01-01',now() FROM generate_series(1,10000) n`;
   await expectBoth({...input,platforms:[]},"UNIFIED_CONFIGURATION_TOO_LARGE");await owner.$executeRawUnsafe("DELETE FROM meta_ads.unified_rules WHERE payload='{}'::jsonb");
   await owner.$executeRawUnsafe("INSERT INTO meta_ads.source_connections(id,provider,external_account_id,display_name,currency_code,time_zone,updated_at) SELECT gen_random_uuid(),'META','bound-'||n,'bound-'||n,'KRW','Asia/Seoul',now() FROM generate_series(1,100) n");
   await expectBoth({...input,platforms:["META"]},"UNIFIED_REPORT_TOO_LARGE");await owner.$executeRawUnsafe("DELETE FROM meta_ads.source_connections WHERE display_name LIKE 'bound-%'");
   await owner.$executeRawUnsafe("INSERT INTO meta_ads.source_connections(id,provider,external_account_id,display_name,currency_code,time_zone,updated_at) SELECT gen_random_uuid(),'META','bound-'||n,'bound-'||n,'KRW','Asia/Seoul',now() FROM generate_series(1,50) n");
   await expectBoth({...input,platforms:["META"]},"UNIFIED_SCOPE_LIMIT");await owner.$executeRawUnsafe("DELETE FROM meta_ads.source_connections WHERE display_name LIKE 'bound-%'");
   await owner.$executeRawUnsafe("INSERT INTO meta_ads.source_connections(id,provider,external_account_id,display_name,currency_code,time_zone,updated_at) SELECT gen_random_uuid(),'META','bound-'||n,'bound-'||n,'KRW','Asia/Seoul',now() FROM generate_series(1,30) n");
   await expectBoth({from:"2025-01-01",to:"2026-01-01",compareFrom:"2023-12-31",compareTo:"2024-12-30",platforms:["META"]},"UNIFIED_REPORT_TOO_LARGE");
   await owner.$executeRawUnsafe("DELETE FROM meta_ads.source_connections WHERE display_name LIKE 'bound-%'");
   await owner.$executeRaw`INSERT INTO meta_ads.unified_aggregation_runs(id,source_system,platform,scope_key,business_date,status,contract_version,versions,read_snapshot_id,source_watermarks,control_totals,issues,completed_at)
     SELECT gen_random_uuid(),'META','META',${scopes.META},'2026-10-26','FAILED',${CONTRACT_VERSION},'{}'::jsonb,'bound-fail','{}'::jsonb,'[]'::jsonb,'[]'::jsonb,now() FROM generate_series(1,20000) n`;
   await expectBoth({...input,platforms:["META"]},"UNIFIED_REPORT_TOO_LARGE");await owner.$executeRawUnsafe("DELETE FROM meta_ads.unified_aggregation_runs WHERE read_snapshot_id='bound-fail'");
   const large=await owner.unifiedAggregationRun.create({data:{sourceSystem:"CAFE24",platform:"CAFE24",scopeKey:scopes.CAFE24,businessDate:new Date("2026-10-23"),contractVersion:CONTRACT_VERSION,versions:{},readSnapshotId:"bound",sourceWatermarks:{},controlTotals:[],issues:[]}});
   await owner.$executeRaw`INSERT INTO meta_ads.unified_daily_facts(id,run_id,component,fact_key,product_name,attribution,payload) SELECT gen_random_uuid(),${large.id}::uuid,'SALE','bound-'||n,'정확제품','DIRECT','{}'::jsonb FROM generate_series(1,100001) n`;
   await owner.unifiedSourceCoverage.create({data:{runId:large.id,component:"SALE",participation:"INCLUDED",collectionState:"COMPLETE",rowsPresent:100001,isEstimate:false,details:{}}});
   await owner.unifiedAggregationRun.update({where:{id:large.id},data:{status:"READY",completedAt:new Date()}});await owner.unifiedSourcePublication.create({data:{sourceSystem:"CAFE24",platform:"CAFE24",scopeKey:scopes.CAFE24,businessDate:new Date("2026-10-23"),runId:large.id}});
   await expectBoth({...input,from:"2026-10-23",platforms:["CAFE24"]},"UNIFIED_REPORT_TOO_LARGE");
   observed.checks.push('actual report-role limits: products10001,rules10001,connections101,scopes51,partitions>20000,failedRuns20001,facts100001');
  });
  observed.status="PASS";
 }finally{await Promise.all([owner.$disconnect(),report.$disconnect()]);writeFileSync("docs/product-performance/research/11-app-report-frame-checks.json",JSON.stringify(observed,null,2)+"\n");}
});
