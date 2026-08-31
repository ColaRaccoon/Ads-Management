import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { AppRole, ConflictPolicy, InviteStatus, PrismaClient, ReportType, StorageTombstoneDomain, StorageTombstoneState } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";
import { preloadApiEnvironment } from "../common/environment-preload";
import { CoupangService } from "../coupang/coupang.service";
import { META_ADSET_REQUIRED_COLUMNS } from "../domain/meta-csv";
import { CAFE24_ORDER_REQUIRED_COLUMNS } from "../domain/cafe24-csv";
import { DecisionsService } from "../decisions/decisions.service";
import { MappingsService } from "../mappings/mappings.service";
import { DashboardMetricsService } from "../metrics/dashboard-metrics.service";
import { MetaAdMetricsReadService } from "../metrics/meta-ad-metrics-read.service";
import { MetaAdsetMetricDecorationService } from "../metrics/meta-adset-metric-decoration.service";
import { MetaAdsetMetricsReadService } from "../metrics/meta-adset-metrics-read.service";
import { MetricsService } from "../metrics/metrics.service";
import { ReportsService } from "../reports/reports.service";
import { Cafe24UploadsService } from "../sales/cafe24-uploads.service";
import { LocalFileStorage } from "../storage/local-file-storage";
import { parseStorageReference, storageReference } from "../storage/storage-reference";
import { StorageTombstoneService } from "../storage/storage-tombstone.service";
import { MetaAdsetImportService } from "../uploads/meta-adset-import.service";
import { MetaEntityWriterService } from "../uploads/meta-entity-writer.service";
import { MetaMetricVersionService } from "../uploads/meta-metric-version.service";
import { UploadExchangeRateService } from "../uploads/upload-exchange-rate.service";
import { UploadLifecycleService } from "../uploads/upload-lifecycle.service";
import { UploadStorageService } from "../uploads/upload-storage.service";

const MUTATION_COMPATIBILITY_CONTRACT_VERSION=2;
class RollbackMutationSmoke extends Error {}

async function run() {
  preloadApiEnvironment();
  const releaseId=process.env.LOCAL_RELEASE_ID?.trim()??"";
  if(!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(releaseId))throw new Error("COMPATIBILITY_RELEASE_ID_INVALID");
  const reportRoot=requiredRoot("REPORT_STORAGE_DIR"),uploadRoot=requiredRoot("UPLOAD_STORAGE_DIR");
  const prisma=new PrismaClient();const reportStorage=new LocalFileStorage(reportRoot);const uploadFileStorage=new LocalFileStorage(uploadRoot);
  const runId=randomUUID(),dateText="2026-08-25",date=new Date(`${dateText}T00:00:00.000Z`);
  const reportKeys:string[]=[],reportTrashKeys:string[]=[],uploadKeys:string[]=[],trashKeys:string[]=[];
  let purgedTombstoneId="";
  let rollbackObserved=false;
  try{
    await prisma.$connect();
    try{
      await prisma.$transaction(async(tx)=>{
        const scoped=transactionScopedPrisma(tx),username=`mutation_${runId}`;
        const actor=await tx.appUser.create({data:{username,normalizedUsername:username,name:"Compatibility operator",role:AppRole.USER,inviteStatus:InviteStatus.ACTIVE}});
        const reviewer=await tx.appUser.create({data:{username:`review_${runId}`,normalizedUsername:`review_${runId}`,name:"Compatibility reviewer",role:AppRole.ADMIN,inviteStatus:InviteStatus.ACTIVE}});
        await tx.exchangeRate.upsert({where:{rateDate_baseCurrency_quoteCurrency_provider:{rateDate:date,baseCurrency:"USD",quoteCurrency:"KRW",provider:"KOREA_EXIM"}},create:{rateDate:date,sourceDate:date,rate:1350,providerPayload:{compatibility:true}},update:{sourceDate:date,rate:1350,providerPayload:{compatibility:true}}});
        const product=await tx.product.create({data:{code:`MUT-${runId}`,name:"Compatibility product",displayName:"Compatibility product",costRules:{create:{salePriceKrw:69000,productCostKrw:25000,fxRateKrwPerUsd:1350,effectiveFrom:date}},cpaRules:{create:{effectiveFrom:date}}}});
        const config=new ConfigService({STORAGE_PROVIDER:"local",APP_DATA_ROOT:path.dirname(reportRoot),UPLOAD_STORAGE_DIR:uploadRoot,REPORT_STORAGE_DIR:reportRoot,SUPABASE_STORAGE_RETENTION_DAYS:"30"});
        const exchangeRates={ensureUsdKrwRatesForDates:async()=>new Map()} as never;
        const mappings=new MappingsService(scoped as never),originalStorage=new UploadStorageService(config);
        const metaImporter=new MetaAdsetImportService(scoped as never,originalStorage,new MetaEntityWriterService(scoped as never),new MetaMetricVersionService(scoped as never),mappings,new UploadExchangeRateService(scoped as never,exchangeRates));
        const adsetName=`Compatibility ${runId}`,metaFile=multerFile("meta-adset.csv",metaAdsetCsv(adsetName));
        const metaImport=await metaImporter.importMetaAdsetCsv(metaFile,ConflictPolicy.SKIP,actor.id),metaReplay=await metaImporter.importMetaAdsetCsv(metaFile,ConflictPolicy.SKIP,actor.id);
        assert(metaReplay.batchId===metaImport.batchId&&metaImport.validRowCount===1,"META_IMPORT_REPLAY_INVALID");
        const metaBatch=await tx.uploadBatch.findUniqueOrThrow({where:{id:metaImport.batchId}}),metaReference=parseStorageReference(metaBatch.storedFilePath??"");
        assert(metaReference?.provider==="local","META_STORAGE_REFERENCE_INVALID");uploadKeys.push(metaReference.key);
        await mappings.createProductRule({productId:product.id,matchType:"CONTAINS",pattern:adsetName,validFrom:"2026-08-01"},actor.id);
        const rematch=await mappings.rematchCurrentMetrics({from:dateText,to:dateText},actor.id);assert(rematch.rematchedCount===1,"META_REMATCH_INVALID");

        const cafe24=new Cafe24UploadsService(scoped as never,exchangeRates);
        await cafe24.createRule({productId:product.id,productNumbers:[`P-${runId.slice(0,8)}`],validFrom:"2026-08-01"},actor.id);
        const cafeImport=await cafe24.importCafe24Csv(multerFile("cafe24.csv",cafe24Csv(runId)),ConflictPolicy.SKIP,actor.id);assert(cafeImport.validRowCount===1,"CAFE24_IMPORT_INVALID");
        const cafeRematch=await cafe24.rematchCafe24Lines({from:dateText,to:dateText,take:"10"},actor.id);assert(cafeRematch.scannedCount===1,"CAFE24_REMATCH_INVALID");

        const coupang=new CoupangService(scoped as never);
        const coupangProduct=await coupang.createProductSetting({standardName:`compatibility-${runId}`,displayName:"Compatibility Coupang product",salePriceKrw:100000,productCostKrw:40000,effectiveFrom:"2026-08-01"},actor.id);
        await coupang.createMappingRule({coupangProductId:coupangProduct.id,includeKeywords:["Compatibility Coupang"],validFrom:"2026-08-01"},actor.id);
        const salesFile=await coupangSalesFile(runId),coupangImport=await coupang.importSalesXlsx(salesFile,{conflictPolicy:"SKIP",reportDate:dateText},actor.id),coupangReplay=await coupang.importSalesXlsx(salesFile,{conflictPolicy:"SKIP",reportDate:dateText},actor.id);
        assert(coupangReplay.batchId===coupangImport.batchId&&coupangImport.validRowCount===1,"COUPANG_IMPORT_REPLAY_INVALID");
        const coupangRematch=await coupang.rematch({from:dateText,to:dateText,take:"10"},actor.id);assert(coupangRematch.scannedSalesCount>=1,"COUPANG_REMATCH_INVALID");
        const manual=await coupang.replaceManualPurchasesForDate(dateText,{vendorFeePerUnitKrw:1000,entries:[{coupangProductId:coupangProduct.id,quantity:1}]},actor.id);assert(manual.selectedOptionCount===1&&manual.totalQuantity===1,"COUPANG_MANUAL_PURCHASE_INVALID");

        const decoration=new MetaAdsetMetricDecorationService(scoped as never),metrics=new MetricsService(new MetaAdMetricsReadService(scoped as never),new MetaAdsetMetricsReadService(scoped as never,decoration),new DashboardMetricsService(scoped as never,decoration),decoration);
        const decision=await new DecisionsService(scoped as never,metrics).run({from:dateText,to:dateText},actor.id);assert(decision.count>0&&decision.count<=100000,"DECISION_RUN_INVALID");
        const reports=new ReportsService(scoped as never,metrics,config),report=await reports.export({reportType:ReportType.PERIOD_XLSX,from:dateText,to:dateText,parameters:{contractVersion:MUTATION_COMPATIBILITY_CONTRACT_VERSION}},reviewer.id);
        const reportReference=parseStorageReference(report.filePath??"");assert(reportReference?.provider==="local"&&Boolean(report.fileHashSha256),"REPORT_REFERENCE_INVALID");reportKeys.push(reportReference.key);
        const download=await reports.download(report.id),downloadedHash=createHash("sha256");for await(const chunk of download.stream)downloadedHash.update(chunk);assert(downloadedHash.digest("hex")===report.fileHashSha256,"REPORT_DOWNLOAD_HASH_INVALID");
        const [coupangDashboard,coupangProfit,coupangAds,coupangDaily]=await Promise.all([coupang.dashboard({from:dateText,to:dateText}),coupang.productProfit({from:dateText,to:dateText}),coupang.adsAnalysis({from:dateText,to:dateText}),coupang.dailyReport({date:dateText})]);
        assert(boundedJson(coupangDashboard)&&boundedJson(coupangProfit)&&boundedJson(coupangAds)&&boundedJson(coupangDaily),"COUPANG_KPI_OUTPUT_INVALID");

        await cafe24.deleteUpload(cafeImport.batchId,actor.id);await coupang.deleteUpload(coupangImport.batchId,actor.id);
        const tombstones=new StorageTombstoneService(scoped as never,config),lifecycle=new UploadLifecycleService(scoped as never,tombstones),deleted=await lifecycle.deleteUpload(metaImport.batchId,actor.id);
        assert(deleted.storedFileRetained&&Boolean(deleted.tombstoneId),"META_UPLOAD_RETENTION_INVALID");trashKeys.push(`trash/${deleted.tombstoneId}`);
        const restored=await lifecycle.restoreStoredObject(deleted.tombstoneId!,actor.id);assert(restored.state==="RESTORED","META_UPLOAD_RESTORE_INVALID");
        const restoredUpload=await uploadFileStorage.getStream(metaReference.key),restoredHash=createHash("sha256");for await(const chunk of restoredUpload.stream)restoredHash.update(chunk);assert(restoredHash.digest("hex")===createHash("sha256").update(metaFile.buffer).digest("hex"),"META_UPLOAD_RESTORE_HASH_INVALID");
        const manualDeleted=await coupang.deleteManualPurchase(manual.rows[0].id,actor.id);assert(manualDeleted.deleted&&manualDeleted.id===manual.rows[0].id,"COUPANG_MANUAL_PURCHASE_DELETE_INVALID");
        assert(await tx.coupangManualPurchase.count({where:{id:manual.rows[0].id}})===0,"COUPANG_MANUAL_PURCHASE_DELETE_NOT_PERSISTED");

        const purgeKey=`compatibility/purge-${runId}.bin`,purgeBytes=Buffer.from(`purge-contract-${runId}`,"utf8"),purgeHash=createHash("sha256").update(purgeBytes).digest("hex");
        await reportStorage.put({key:purgeKey,body:purgeBytes,expectedHashSha256:purgeHash,maxBytes:purgeBytes.length});reportKeys.push(purgeKey);
        const retainedForPurge=await tombstones.retain({domain:StorageTombstoneDomain.REPORT,businessRecordId:randomUUID(),reference:storageReference("local",purgeKey),expectedHashSha256:purgeHash,actorUserId:actor.id});
        purgedTombstoneId=retainedForPurge.tombstoneId;const purgeTrashKey=`trash/${purgedTombstoneId}`;reportTrashKeys.push(purgeTrashKey);
        assert(retainedForPurge.state===StorageTombstoneState.RETAINED&&!await reportStorage.exists(purgeKey)&&await reportStorage.exists(purgeTrashKey),"REPORT_PURGE_RETENTION_INVALID");
        const purged=await lifecycle.purgeStoredObject(purgedTombstoneId,actor.id),purgedRow=await tx.storageTombstone.findUniqueOrThrow({where:{id:purgedTombstoneId}});
        assert(purged.state===StorageTombstoneState.PURGED&&purgedRow.state===StorageTombstoneState.PURGED&&purgedRow.hashSha256===purgeHash&&purgedRow.byteSize===BigInt(purgeBytes.length),"REPORT_PURGE_STATE_OR_HASH_INVALID");
        assert(!await reportStorage.exists(purgeKey)&&!await reportStorage.exists(purgeTrashKey),"REPORT_PURGE_BYTES_REMAIN");
        throw new RollbackMutationSmoke();
      },{timeout:300_000});
      throw new Error("COMPATIBILITY_MUTATION_ROLLBACK_MISSING");
    }catch(error){if(!(error instanceof RollbackMutationSmoke))throw error;rollbackObserved=true}
    assert(await prisma.appUser.count({where:{normalizedUsername:`mutation_${runId}`}})===0,"COMPATIBILITY_DATABASE_ROLLBACK_FAILED");
    assert(!purgedTombstoneId||await prisma.storageTombstone.count({where:{id:purgedTombstoneId}})===0,"COMPATIBILITY_PURGE_TOMBSTONE_ROLLBACK_FAILED");
    for(const key of trashKeys)assert(!await uploadFileStorage.exists(key),"COMPATIBILITY_TOMBSTONE_TRASH_REMAINS");
    for(const key of reportTrashKeys)assert(!await reportStorage.exists(key),"COMPATIBILITY_PURGE_TRASH_REMAINS");
    const flows=["MetaAdsetImportService.importMetaAdsetCsv:duplicate-replay","MappingsService.createProductRule+rematchCurrentMetrics","Cafe24UploadsService.import+rematch+deleteUpload","CoupangService.importSales+rematch+deleteUpload","CoupangService.replaceManualPurchasesForDate+deleteManualPurchase","DecisionsService.run","ReportsService.export+download:hash-verified","UploadLifecycleService.deleteUpload+StorageTombstoneService.restore:hash-verified","UploadLifecycleService.purgeStoredObject:db-hash-and-byte-absence-verified"];
    const digest=createHash("sha256").update(JSON.stringify({contractVersion:MUTATION_COMPATIBILITY_CONTRACT_VERSION,flows})).digest("hex");
    process.stdout.write(`${JSON.stringify({event:"mutation-compatibility-smoke",releaseId,contractVersion:MUTATION_COMPATIBILITY_CONTRACT_VERSION,digest,flows,flowCount:flows.length,databaseMutations:10,storageMutations:10,rollbackVerified:rollbackObserved,storageHashVerified:true})}\n`);
  }finally{
    for(const key of [...reportKeys,...reportTrashKeys])await reportStorage.delete(key).catch(()=>false);
    for(const key of [...uploadKeys,...trashKeys])await uploadFileStorage.delete(key).catch(()=>false);
    await prisma.$disconnect();
  }
}

function transactionScopedPrisma<T extends object>(transaction:T){let proxy:T;proxy=new Proxy(transaction,{get(target,property){if(property==="$transaction")return async(callback:(client:T)=>unknown)=>callback(proxy);const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value}});return proxy}
function requiredRoot(name:string){const value=process.env[name]?.trim()??"";if(!value||!path.isAbsolute(value))throw new Error(`${name}_INVALID`);return value}
function assert(condition:unknown,code:string):asserts condition{if(!condition)throw new Error(code)}
function boundedJson(value:unknown){const json=JSON.stringify(value);return Buffer.byteLength(json,"utf8")<=32*1024*1024}
function multerFile(originalname:string,buffer:Buffer):Express.Multer.File{return{fieldname:"file",originalname,encoding:"7bit",mimetype:"application/octet-stream",size:buffer.length,buffer} as Express.Multer.File}
function csvCell(value:string){return`"${value.replace(/"/g,'""')}"`}
function metaAdsetCsv(adsetName:string){const row:Record<string,string>={"보고 시작":"2026-08-25","보고 종료":"2026-08-25","광고 세트 이름":adsetName,"광고 세트 게재":"active","결과":"2","결과 표시 도구":"구매","도달":"80","지출 금액 (USD)":"20","노출":"100"};return Buffer.from([META_ADSET_REQUIRED_COLUMNS.map(csvCell).join(","),META_ADSET_REQUIRED_COLUMNS.map((header)=>csvCell(row[header]??"")).join(",")].join("\n"),"utf8")}
function cafe24Csv(runId:string){const values=[`20260825-${runId.slice(0,8)}`,`20260825-${runId.slice(0,8)}-01`,"138000",`P-${runId.slice(0,8)}`,"Compatibility product","Compatibility option","2","69000","카드","2026-08-25 10:20:30"];return Buffer.from([CAFE24_ORDER_REQUIRED_COLUMNS.map(csvCell).join(","),values.map(csvCell).join(",")].join("\n"),"utf8")}
async function coupangSalesFile(runId:string){const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet("sales");sheet.addRow(["Option ID","Option Name","Product Name","Sale Method","Sales(KRW)","Orders","Sales Quantity","Total Sales(KRW)","Total Sales Quantity","Cancel Amount(KRW)","Cancel Quantity","Instant Cancel Quantity"]);sheet.addRow([`A-${runId}`,"Compatibility option","Compatibility Coupang product","seller",100000,1,10,100000,10,0,0,0]);return multerFile(`sales-2026-08-25-${runId}.xlsx`,Buffer.from(await workbook.xlsx.writeBuffer()))}

void run().catch(()=>{process.stderr.write('{"event":"mutation-compatibility-smoke","result":"FAIL"}\n');process.exitCode=1});
