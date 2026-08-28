import {
  AppRole, ConflictPolicy, DecisionType, InviteStatus, MatchSource, MatchType, Prisma, PrismaClient,
  ReportType, SecurityAuditActorType, SecurityAuditResult, UploadLevel, UploadStatus
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseIntegrationEnabled } from "../common/supabase-integration-target";
import { LocalFileStorage } from "../storage/local-file-storage";
import ExcelJS from "exceljs";
import { CoupangService } from "../coupang/coupang.service";
import { ConfigService } from "@nestjs/config";
import { CAFE24_ORDER_REQUIRED_COLUMNS } from "../domain/cafe24-csv";
import { META_ADSET_REQUIRED_COLUMNS } from "../domain/meta-csv";
import { Cafe24UploadsService } from "../sales/cafe24-uploads.service";
import { MappingsService } from "../mappings/mappings.service";
import { MetaAdsetImportService } from "../uploads/meta-adset-import.service";
import { MetaEntityWriterService } from "../uploads/meta-entity-writer.service";
import { MetaMetricVersionService } from "../uploads/meta-metric-version.service";
import { UploadExchangeRateService } from "../uploads/upload-exchange-rate.service";
import { UploadStorageService } from "../uploads/upload-storage.service";
import { MetaAdMetricsReadService } from "../metrics/meta-ad-metrics-read.service";
import { MetaAdsetMetricDecorationService } from "../metrics/meta-adset-metric-decoration.service";
import { MetaAdsetMetricsReadService } from "../metrics/meta-adset-metrics-read.service";
import { DashboardMetricsService } from "../metrics/dashboard-metrics.service";
import { MetricsService } from "../metrics/metrics.service";
import { ReportsService } from "../reports/reports.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";

const integrationDescribe = supabaseIntegrationEnabled("RUN_BUSINESS_SUPABASE_INTEGRATION", "DATABASE_URL") ? describe : describe.skip;
class RollbackRehearsal extends Error {}

integrationDescribe("synthetic business flow on an isolated Supabase project", () => {
  let prisma: PrismaClient;
  let storageRoot: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    storageRoot = await mkdtemp(path.join(tmpdir(), "meta-business-rehearsal-"));
  });
  afterAll(async () => { await prisma.$disconnect(); await rm(storageRoot,{recursive:true,force:true}); });

  it("connects current-row KPIs, report/hash output, duplicate retry and two-user audit in one rollback-only rehearsal", async () => {
    const runId=randomUUID();
    const workbook=new ExcelJS.Workbook();const worksheet=workbook.addWorksheet("Rehearsal");worksheet.addRow(["run_id","kind"]);worksheet.addRow([runId,"synthetic-business-rehearsal"]);
    const payload=Buffer.from(await workbook.xlsx.writeBuffer());
    const fileHash=createHash("sha256").update(payload).digest("hex");
    const storage=new LocalFileStorage(storageRoot);
    const stored=await storage.put({key:`reports/${runId}.xlsx`,body:payload,expectedHashSha256:fileHash});
    expect(stored.hash).toBe(fileHash);

    await expect(prisma.$transaction(async(tx)=>{
      const actor=await tx.appUser.create({data:{username:`rehearsal_a_${runId}`,normalizedUsername:`rehearsal_a_${runId}`,name:"Synthetic operator A",role:AppRole.USER,inviteStatus:InviteStatus.ACTIVE}});
      const reviewer=await tx.appUser.create({data:{username:`rehearsal_b_${runId}`,normalizedUsername:`rehearsal_b_${runId}`,name:"Synthetic operator B",role:AppRole.GUEST,inviteStatus:InviteStatus.ACTIVE}});
      const metaBatch=await tx.uploadBatch.create({data:{originalFilename:"synthetic-meta.xlsx",storedFilePath:`local:uploads/${runId}-meta.xlsx`,fileHashSha256:createHash("sha256").update(`${runId}:meta`).digest("hex"),level:UploadLevel.ADSET,columnSchema:{fixtureVersion:1},rowCount:1,validRowCount:1,conflictPolicy:ConflictPolicy.SKIP,status:UploadStatus.IMPORTED,uploadedBy:actor.id}});
      const adset=await tx.metaAdset.create({data:{externalAdsetId:`synthetic-${runId}`,adsetName:"Synthetic adset",adsetNameKey:`synthetic-${runId}`}});
      const date=new Date("2026-08-25T00:00:00.000Z");
      await tx.metaAdsetDailyMetric.create({data:{uploadBatchId:metaBatch.id,metaAdsetId:adset.id,metricDate:date,dateStart:date,dateEnd:date,adsetName:"Synthetic adset",adsetNameKey:`synthetic-${runId}`,spendUsd:20,resultCount:2,rawRow:{fixtureVersion:1},isCurrent:true}});
      const cafeBatch=await tx.cafe24UploadBatch.create({data:{originalFilename:"synthetic-cafe24.xlsx",storedFilePath:`local:uploads/${runId}-cafe24.xlsx`,fileHashSha256:createHash("sha256").update(`${runId}:cafe24`).digest("hex"),columnSchema:{fixtureVersion:1},rowCount:1,validRowCount:1,status:UploadStatus.IMPORTED,uploadedBy:actor.id}});
      await tx.cafe24OrderLine.create({data:{uploadBatchId:cafeBatch.id,rowNumber:1,sourceRowHash:createHash("sha256").update(`${runId}:cafe-row`).digest("hex"),orderLineKey:`order-${runId}`,orderNo:`order-${runId}`,lineOrderNo:"1",productNo:"synthetic",productName:"Synthetic product",optionName:"Synthetic option",quantity:2,salePriceKrw:69000,totalPaidKrw:138000,orderDate:date,isCurrent:true}});
      const salesWorkbook=new ExcelJS.Workbook();const salesSheet=salesWorkbook.addWorksheet("sales");salesSheet.addRow(["Option ID","Option Name","Product Name","Sale Method","Sales(KRW)","Orders","Sales Quantity","Total Sales(KRW)","Total Sales Quantity","Cancel Amount(KRW)","Cancel Quantity","Instant Cancel Quantity"]);salesSheet.addRow([`A-${runId}`,"Synthetic option","Synthetic product","seller",100000,1,10,100000,10,0,0,0]);const salesBuffer=Buffer.from(await salesWorkbook.xlsx.writeBuffer());
      const salesFile={fieldname:"sales",originalname:`sales-2026-08-25-${runId}.xlsx`,encoding:"7bit",mimetype:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",size:salesBuffer.length,buffer:salesBuffer} as Express.Multer.File;
      const coupangService=new CoupangService(transactionScopedPrisma(tx) as never);const firstImport=await coupangService.importSalesXlsx(salesFile,{conflictPolicy:"SKIP",reportDate:"2026-08-25"},actor.id);const replayImport=await coupangService.importSalesXlsx(salesFile,{conflictPolicy:"SKIP",reportDate:"2026-08-25"},actor.id);expect(replayImport.batchId).toBe(firstImport.batchId);expect(await tx.coupangUploadBatch.count({where:{id:firstImport.batchId}})).toBe(1);const coupangBatch=await tx.coupangUploadBatch.findUniqueOrThrow({where:{id:firstImport.batchId}});
      await tx.coupangAdMetric.create({data:{uploadBatchId:coupangBatch.id,rowNumber:2,sourceRowHash:createHash("sha256").update(`${runId}:ad`).digest("hex"),adMetricKey:`ad-${runId}`,metricDate:date,adExecutionProductName:"Synthetic product",conversionProductName:"Synthetic product",adSpendKrw:8000,totalOrders1d:4,isCurrent:true}});
      const decision=await tx.decisionLog.create({data:{decisionDate:date,periodStart:date,periodEnd:date,scopeType:"SYNTHETIC_REHEARSAL",metaAdsetId:adset.id,decision:DecisionType.KEEP,reason:"Synthetic regression proof",metricsSnapshot:{fixtureVersion:1},createdBy:actor.id}});
      await tx.changeLog.create({data:{actionDate:date,actionType:"SYNTHETIC_REHEARSAL",targetType:"META_ADSET",metaAdsetId:adset.id,reason:"Synthetic two-user mutation proof",relatedDecisionId:decision.id,createdBy:reviewer.id}});
      await tx.reportExport.create({data:{reportType:ReportType.PERIOD_XLSX,periodStart:date,periodEnd:date,parameters:{fixtureVersion:1},filePath:`local:${stored.key}`,fileHashSha256:stored.hash,status:"CREATED",createdBy:reviewer.id}});
      for(const [user,action] of [[actor,"BUSINESS_REHEARSAL_IMPORT"],[reviewer,"BUSINESS_REHEARSAL_REVIEW"]] as const){await tx.securityAuditEvent.create({data:{actorUserId:user.id,actorType:SecurityAuditActorType.USER,action,targetType:"SYNTHETIC_REHEARSAL",targetId:runId,result:SecurityAuditResult.SUCCESS,afterJson:{fixtureVersion:1}}});}
      const duplicate=await tx.uploadBatch.findUnique({where:{fileHashSha256:metaBatch.fileHashSha256}});expect(duplicate?.id).toBe(metaBatch.id);expect(await tx.uploadBatch.count({where:{fileHashSha256:metaBatch.fileHashSha256}})).toBe(1);
      const schema=process.env.SUPABASE_TEST_DATABASE_SCHEMA??"";if(!/^test_[a-z0-9_]{3,58}$/.test(schema))throw new Error("TEST_SCHEMA_INVALID");const qualified=Prisma.raw(`"${schema}"`);
      const kpi=await tx.$queryRaw<Array<Record<string,bigint|string>>>(Prisma.sql`SELECT (SELECT count(*) FROM ${qualified}."meta_adset_daily_metrics" WHERE "is_current" AND "upload_batch_id"=${metaBatch.id}::uuid) AS meta_rows,(SELECT coalesce(sum("spend_usd"),0)::text FROM ${qualified}."meta_adset_daily_metrics" WHERE "is_current" AND "upload_batch_id"=${metaBatch.id}::uuid) AS meta_spend,(SELECT count(*) FROM ${qualified}."cafe24_order_lines" WHERE "is_current" AND "upload_batch_id"=${cafeBatch.id}::uuid) AS cafe_rows,(SELECT coalesce(sum("total_paid_krw"),0)::text FROM ${qualified}."cafe24_order_lines" WHERE "is_current" AND "upload_batch_id"=${cafeBatch.id}::uuid) AS cafe_paid,(SELECT count(*) FROM ${qualified}."coupang_sale_lines" WHERE "is_current" AND "upload_batch_id"=${coupangBatch.id}::uuid) AS coupang_rows,(SELECT coalesce(sum("net_sales_krw"),0)::text FROM ${qualified}."coupang_sale_lines" WHERE "is_current" AND "upload_batch_id"=${coupangBatch.id}::uuid) AS coupang_sales,(SELECT count(*) FROM ${qualified}."report_exports" WHERE "file_hash_sha256"=${stored.hash}) AS reports,(SELECT count(*) FROM ${qualified}."security_audit_events" WHERE "target_id"=${runId}) AS audits`);
      expect(kpi).toHaveLength(1);expect(Number(kpi[0].meta_rows)).toBe(1);expect(Number(kpi[0].meta_spend)).toBe(20);expect(Number(kpi[0].cafe_rows)).toBe(1);expect(Number(kpi[0].cafe_paid)).toBe(138000);expect(Number(kpi[0].coupang_rows)).toBe(1);expect(Number(kpi[0].coupang_sales)).toBe(100000);expect(Number(kpi[0].reports)).toBe(1);expect(Number(kpi[0].audits)).toBe(2);
      throw new RollbackRehearsal();
    },{timeout:120_000})).rejects.toBeInstanceOf(RollbackRehearsal);
    expect(await prisma.securityAuditEvent.count({where:{targetId:runId}})).toBe(0);
    const restored=await storage.getStream(stored.key);const restoredHash=createHash("sha256");const restoredChunks:Buffer[]=[];for await(const chunk of restored.stream){const bytes=Buffer.from(chunk);restoredHash.update(bytes);restoredChunks.push(bytes)}expect(restoredHash.digest("hex")).toBe(fileHash);
    const verifiedWorkbook=new ExcelJS.Workbook();await verifiedWorkbook.xlsx.load(Buffer.concat(restoredChunks) as never);expect(verifiedWorkbook.getWorksheet("Rehearsal")?.getCell("A2").text).toBe(runId);
    expect(await storage.delete(stored.key)).toBe(true);
  },150_000);

  it("runs the production Meta/Cafe24/Coupang, mapping, report and audit services in one rollback-only flow", async () => {
    const runId=randomUUID();
    await expect(prisma.$transaction(async(tx)=>{
      const scoped=transactionScopedPrisma(tx);
      const actor=await tx.appUser.create({data:{username:`flow_a_${runId}`,normalizedUsername:`flow_a_${runId}`,name:"Flow operator",role:AppRole.USER,inviteStatus:InviteStatus.ACTIVE}});
      const reviewer=await tx.appUser.create({data:{username:`flow_b_${runId}`,normalizedUsername:`flow_b_${runId}`,name:"Flow reviewer",role:AppRole.ADMIN,inviteStatus:InviteStatus.ACTIVE}});
      const date=new Date("2026-08-25T00:00:00.000Z");
      await tx.exchangeRate.create({data:{rateDate:date,sourceDate:date,rate:1350,providerPayload:{fixtureVersion:1}}});

      const config=new ConfigService({STORAGE_PROVIDER:"local",APP_DATA_ROOT:storageRoot,UPLOAD_STORAGE_DIR:path.join(storageRoot,"uploads"),REPORT_STORAGE_DIR:path.join(storageRoot,"reports")});
      const exchangeRates={ensureUsdKrwRatesForDates:async()=>new Map()} as never;
      const mappings=new MappingsService(scoped as never);
      const metaImporter=new MetaAdsetImportService(
        scoped as never,
        new UploadStorageService(config),
        new MetaEntityWriterService(scoped as never),
        new MetaMetricVersionService(scoped as never),
        mappings,
        new UploadExchangeRateService(scoped as never,exchangeRates)
      );
      const adsetName=`Synthetic integrated ${runId}`;
      const metaFile=multerFile("meta-adset.csv",metaAdsetCsv(adsetName));
      const metaImport=await metaImporter.importMetaAdsetCsv(metaFile,ConflictPolicy.SKIP,actor.id);
      const metaReplay=await metaImporter.importMetaAdsetCsv(metaFile,ConflictPolicy.SKIP,actor.id);
      expect(metaReplay.batchId).toBe(metaImport.batchId);
      expect(await tx.uploadBatch.count({where:{id:metaImport.batchId}})).toBe(1);

      const product=await tx.product.create({data:{code:`FLOW-${runId}`,name:"Synthetic integrated product",displayName:"Synthetic integrated product"}});
      await mappings.createProductRule({productId:product.id,matchType:"CONTAINS",pattern:adsetName,validFrom:"2026-08-01"},actor.id);
      const rematch=await mappings.rematchCurrentMetrics({from:"2026-08-25",to:"2026-08-25"},actor.id);
      expect(rematch.rematchedCount).toBe(1);

      const cafeService=new Cafe24UploadsService(scoped as never,exchangeRates);
      const cafeImport=await cafeService.importCafe24Csv(multerFile("cafe24.csv",cafe24Csv(runId)),ConflictPolicy.SKIP,actor.id);
      expect(cafeImport.validRowCount).toBe(1);

      const salesWorkbook=new ExcelJS.Workbook();const salesSheet=salesWorkbook.addWorksheet("sales");salesSheet.addRow(["Option ID","Option Name","Product Name","Sale Method","Sales(KRW)","Orders","Sales Quantity","Total Sales(KRW)","Total Sales Quantity","Cancel Amount(KRW)","Cancel Quantity","Instant Cancel Quantity"]);salesSheet.addRow([`A-${runId}`,"Synthetic option","Synthetic product","seller",100000,1,10,100000,10,0,0,0]);const salesBuffer=Buffer.from(await salesWorkbook.xlsx.writeBuffer());
      const coupangService=new CoupangService(scoped as never);const coupangImport=await coupangService.importSalesXlsx(multerFile(`sales-2026-08-25-${runId}.xlsx`,salesBuffer),{conflictPolicy:"SKIP",reportDate:"2026-08-25"},actor.id);const coupangReplay=await coupangService.importSalesXlsx(multerFile(`sales-2026-08-25-${runId}.xlsx`,salesBuffer),{conflictPolicy:"SKIP",reportDate:"2026-08-25"},actor.id);expect(coupangReplay.batchId).toBe(coupangImport.batchId);

      const adsetMetric=await tx.metaAdsetDailyMetric.findFirstOrThrow({where:{uploadBatchId:metaImport.batchId,isCurrent:true}});
      const decision=await tx.decisionLog.create({data:{decisionDate:date,periodStart:date,periodEnd:date,scopeType:"INTEGRATED_REHEARSAL",metaAdsetId:adsetMetric.metaAdsetId,decision:DecisionType.KEEP,reason:"Integrated service proof",metricsSnapshot:{fixtureVersion:1},createdBy:actor.id}});
      await tx.changeLog.create({data:{actionDate:date,actionType:"INTEGRATED_REHEARSAL",targetType:"META_ADSET",metaAdsetId:adsetMetric.metaAdsetId,reason:"Integrated reviewer proof",relatedDecisionId:decision.id,createdBy:reviewer.id}});
      await writeSecurityAudit(tx,{actorUserId:reviewer.id,actorType:SecurityAuditActorType.USER,action:"BUSINESS_FLOW_REVIEWED",targetType:"INTEGRATED_REHEARSAL",targetId:runId,result:SecurityAuditResult.SUCCESS,afterJson:{fixtureVersion:1}});

      const decoration=new MetaAdsetMetricDecorationService(scoped as never);
      const metrics=new MetricsService(new MetaAdMetricsReadService(scoped as never),new MetaAdsetMetricsReadService(scoped as never,decoration),new DashboardMetricsService(scoped as never,decoration),decoration);
      const reports=new ReportsService(scoped as never,metrics,config);
      const report=await reports.export({reportType:"PERIOD_XLSX",from:"2026-08-25",to:"2026-08-25",parameters:{fixtureVersion:1}},reviewer.id);
      const download=await reports.download(report.id);const reportChunks:Buffer[]=[];const reportHash=createHash("sha256");for await(const chunk of download.stream){const bytes=Buffer.from(chunk);reportHash.update(bytes);reportChunks.push(bytes)}expect(reportHash.digest("hex")).toBe(report.fileHashSha256);const reportWorkbook=new ExcelJS.Workbook();await reportWorkbook.xlsx.load(Buffer.concat(reportChunks) as never);expect(reportWorkbook.getWorksheet("Summary")?.getCell("A1").text).toBe("Period");

      const schema=process.env.SUPABASE_TEST_DATABASE_SCHEMA??"";if(!/^test_[a-z0-9_]{3,58}$/.test(schema))throw new Error("TEST_SCHEMA_INVALID");const qualified=Prisma.raw(`"${schema}"`);
      const kpi=await tx.$queryRaw<Array<Record<string,bigint|string>>>(Prisma.sql`SELECT (SELECT count(*) FROM ${qualified}."meta_adset_daily_metrics" WHERE "is_current" AND "upload_batch_id"=${metaImport.batchId}::uuid) AS meta_rows,(SELECT count(*) FROM ${qualified}."cafe24_order_lines" WHERE "is_current" AND "upload_batch_id"=${cafeImport.batchId}::uuid) AS cafe_rows,(SELECT count(*) FROM ${qualified}."coupang_sale_lines" WHERE "is_current" AND "upload_batch_id"=${coupangImport.batchId}::uuid) AS coupang_rows,(SELECT count(*) FROM ${qualified}."report_exports" WHERE "id"=${report.id}::uuid AND "status"='CREATED') AS reports,(SELECT count(*) FROM ${qualified}."security_audit_events" WHERE "actor_user_id" IN (${actor.id}::uuid,${reviewer.id}::uuid)) AS audits`);
      expect(kpi).toEqual([expect.objectContaining({meta_rows:1n,cafe_rows:1n,coupang_rows:1n,reports:1n})]);expect(Number(kpi[0].audits)).toBeGreaterThanOrEqual(3);
      throw new RollbackRehearsal();
    },{timeout:120_000})).rejects.toBeInstanceOf(RollbackRehearsal);
    expect(await prisma.securityAuditEvent.count({where:{targetId:runId}})).toBe(0);
  },150_000);

  it("keeps manual legacy adoption behind the same advisory fence held by rematch", async () => {
    const runId=randomUUID();
    const date=new Date("2026-08-25T00:00:00.000Z");
    const actor=await prisma.appUser.create({data:{username:`mapping_lock_${runId}`,normalizedUsername:`mapping_lock_${runId}`,name:"Mapping lock rehearsal",role:AppRole.ADMIN,inviteStatus:InviteStatus.ACTIVE}});
    const ruleProduct=await prisma.product.create({data:{code:`RULE-${runId}`,name:"Rule product",displayName:"Rule product"}});
    const manualProduct=await prisma.product.create({data:{code:`MANUAL-${runId}`,name:"Manual product",displayName:"Manual product"}});
    const adset=await prisma.metaAdset.create({data:{adsetName:`Legacy lock ${runId}`,adsetNameKey:`legacy lock ${runId}`}});
    const batch=await prisma.uploadBatch.create({data:{originalFilename:"mapping-lock.csv",fileHashSha256:createHash("sha256").update(runId).digest("hex"),level:UploadLevel.ADSET,columnSchema:{fixtureVersion:1},rowCount:1,validRowCount:1,conflictPolicy:ConflictPolicy.SKIP,status:UploadStatus.IMPORTED,uploadedBy:actor.id}});
    const metric=await prisma.metaAdsetDailyMetric.create({data:{uploadBatchId:batch.id,metaAdsetId:adset.id,metricDate:date,dateStart:date,dateEnd:date,adsetName:adset.adsetName,adsetNameKey:adset.adsetNameKey,spendUsd:1,resultCount:1,rawRow:{fixtureVersion:1},isCurrent:true}});
    const rule=await prisma.productMatchRule.create({data:{productId:ruleProduct.id,matchType:MatchType.CONTAINS,pattern:runId,patternKey:runId,priority:1,validFrom:new Date("2026-08-01T00:00:00.000Z"),createdBy:actor.id}});
    const rematchAtRowUpdate=deferred<void>();const releaseRematch=deferred<void>();
    let legacyRowUpdateEntered=false;
    let rematchPromise:Promise<unknown>|undefined;let manualPromise:Promise<unknown>|undefined;
    try{
      const rematchPrisma=interceptMetaAdsetTransactions(prisma,async(args)=>{
        if(args.data?.currentProductId===ruleProduct.id){rematchAtRowUpdate.resolve();await releaseRematch.promise;}
      });
      const manualPrisma=interceptMetaAdsetTransactions(prisma,async(args)=>{
        if(args.data?.externalAdsetId===`external-${runId}`)legacyRowUpdateEntered=true;
      });
      rematchPromise=new MappingsService(rematchPrisma as never).rematchCurrentMetrics({from:"2026-08-25",to:"2026-08-25"});
      await rematchAtRowUpdate.promise;
      manualPromise=new MappingsService(manualPrisma as never).createManualProductMapping({externalAdsetId:`external-${runId}`,adsetName:adset.adsetName,productId:manualProduct.id,effectiveFrom:"2026-08-25",applyCurrentMetrics:true},actor.id);
      await waitForAdvisoryWait(prisma);
      expect(legacyRowUpdateEntered).toBe(false);
      releaseRematch.resolve();
      await expect(rematchPromise).resolves.toMatchObject({rematchedCount:1});
      await expect(manualPromise).resolves.toMatchObject({rematchedMetricCount:1});
      await expect(prisma.metaAdsetDailyMetric.findUnique({where:{id:metric.id}})).resolves.toMatchObject({productId:manualProduct.id,productMatchSource:MatchSource.MANUAL});
      await expect(prisma.metaAdset.findUnique({where:{id:adset.id}})).resolves.toMatchObject({externalAdsetId:`external-${runId}`,currentProductId:manualProduct.id});
    }finally{
      releaseRematch.resolve();
      await Promise.allSettled([rematchPromise,manualPromise].filter((value):value is Promise<unknown>=>Boolean(value)));
      await prisma.$transaction(async(tx)=>{
        await tx.adsetProductHistory.deleteMany({where:{metaAdsetId:adset.id}});
        await tx.metaAdsetDailyMetric.deleteMany({where:{id:metric.id}});
        await tx.productMatchRule.deleteMany({where:{id:rule.id}});
        await tx.metaAdset.update({where:{id:adset.id},data:{currentProductId:null}}).catch(()=>undefined);
        await tx.uploadBatch.deleteMany({where:{id:batch.id}});
        await tx.metaAdset.deleteMany({where:{id:adset.id}});
        await tx.product.deleteMany({where:{id:{in:[ruleProduct.id,manualProduct.id]}}});
        await tx.appUser.update({where:{id:actor.id},data:{isActive:false,deactivatedAt:new Date()}});
      });
    }
  },120_000);
});

function transactionScopedPrisma<T extends object>(transaction:T){
  let proxy:T;
  proxy=new Proxy(transaction,{get(target,property){if(property==="$transaction")return async(callback:(client:T)=>unknown)=>callback(proxy);const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value}});
  return proxy;
}

function interceptMetaAdsetTransactions(prisma:PrismaClient,beforeUpdate:(args:any)=>Promise<void>){
  return new Proxy(prisma,{get(target,property){
    if(property==="$transaction")return async(work:(tx:unknown)=>unknown,options?:unknown)=>target.$transaction(async(tx)=>{
      let scoped:any;
      const metaAdset=new Proxy(tx.metaAdset,{get(delegate,operation){const value=Reflect.get(delegate,operation,delegate);if(operation==="update")return async(args:any)=>{await beforeUpdate(args);return value.call(delegate,args)};return typeof value==="function"?value.bind(delegate):value}});
      scoped=new Proxy(tx,{get(client,key){if(key==="metaAdset")return metaAdset;if(key==="$transaction")return async(callback:(nested:unknown)=>unknown)=>callback(scoped);const value=Reflect.get(client,key,client);return typeof value==="function"?value.bind(client):value}});
      return work(scoped);
    },options as never);
    const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
  }});
}

async function waitForAdvisoryWait(prisma:PrismaClient){
  const deadline=Date.now()+5_000;
  while(Date.now()<deadline){
    const rows=await prisma.$queryRaw<Array<{waiting:bigint}>>(Prisma.sql`SELECT count(*) AS waiting FROM pg_locks WHERE locktype='advisory' AND NOT granted`);
    if(Number(rows[0]?.waiting??0)>0)return;
    await new Promise((resolve)=>setTimeout(resolve,25));
  }
  throw new Error("MAPPING_ADVISORY_WAIT_NOT_OBSERVED");
}

function deferred<T>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>((done)=>{resolve=done});return{promise,resolve};}

function multerFile(originalname:string,buffer:Buffer):Express.Multer.File{return{fieldname:"file",originalname,encoding:"7bit",mimetype:"application/octet-stream",size:buffer.length,buffer} as Express.Multer.File;}
function csvCell(value:string){return`"${value.replace(/"/g,'""')}"`;}
function metaAdsetCsv(adsetName:string){const row:Record<string,string>={"보고 시작":"2026-08-25","보고 종료":"2026-08-25","광고 세트 이름":adsetName,"광고 세트 게재":"active","결과":"2","결과 표시 도구":"구매","도달":"80","지출 금액 (USD)":"20","노출":"100"};return Buffer.from([META_ADSET_REQUIRED_COLUMNS.map(csvCell).join(","),META_ADSET_REQUIRED_COLUMNS.map((header)=>csvCell(row[header]??"")).join(",")].join("\n"),"utf8");}
function cafe24Csv(runId:string){const values=[`20260825-${runId.slice(0,8)}`,`20260825-${runId.slice(0,8)}-01`,"138000",`P-${runId.slice(0,8)}`,"Synthetic product","Synthetic option","2","69000","카드","2026-08-25 10:20:30"];return Buffer.from([CAFE24_ORDER_REQUIRED_COLUMNS.map(csvCell).join(","),values.map(csvCell).join(",")].join("\n"),"utf8");}
