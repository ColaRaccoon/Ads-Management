import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createHash } from "node:crypto";
import { preloadApiEnvironment } from "../common/environment-preload";
import { MetricsService } from "../metrics/metrics.service";
import { CoupangService } from "../coupang/coupang.service";
import { Cafe24UploadsService } from "../sales/cafe24-uploads.service";
import { HealthService } from "../health/health.service";

async function run() {
  preloadApiEnvironment();
  const from=requiredDate("COMPATIBILITY_SMOKE_FROM"),to=requiredDate("COMPATIBILITY_SMOKE_TO"),releaseId=process.env.LOCAL_RELEASE_ID?.trim();
  if(!releaseId||!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(releaseId))throw new Error("COMPATIBILITY_RELEASE_ID_INVALID");
  const { AppModule }=await import("../app.module");const app=await NestFactory.createApplicationContext(AppModule,{logger:false});
  try{
    await app.get(HealthService).assertReady();
    const metrics=app.get(MetricsService),coupang=app.get(CoupangService),cafe24=app.get(Cafe24UploadsService);
    const [summary,products,adsets,coupangUploads,cafe24Uploads]=await Promise.all([
      metrics.dashboardSummary(from,to),metrics.productMetrics(from,to),metrics.adsetMetrics({from,to}),coupang.listUploads(10),cafe24.listUploads(10)
    ]);
    const canonical=JSON.stringify({summary,productCount:products.length,adsetCount:adsets.length,coupangUploadCount:coupangUploads.length,cafe24UploadCount:cafe24Uploads.length});
    process.stdout.write(`${JSON.stringify({event:"business-compatibility-smoke",releaseId,digest:createHash("sha256").update(canonical).digest("hex"),services:["HealthService","MetricsService","CoupangService","Cafe24UploadsService"]})}\n`);
  }finally{await app.close()}
}
function requiredDate(name:string){const value=process.env[name]?.trim()??"";if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)))throw new Error(`${name}_INVALID`);return value}
void run().catch(()=>{process.stderr.write('{"event":"business-compatibility-smoke","result":"FAIL"}\n');process.exitCode=1});
