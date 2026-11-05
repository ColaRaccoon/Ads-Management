import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { Reflector } from "@nestjs/core";
import { productionCafe24Db } from "./cafe24-production-context";
import { HeavyOperationGate } from "../apps/api/src/common/heavy-operation";
import { SyncFoundationService } from "../apps/api/src/daily-sync/sync-foundation.service";
import { GoogleAdsClient } from "../apps/api/src/daily-sync/google-ads.client";
import { GoogleCanonicalWriterService } from "../apps/api/src/daily-sync/google-canonical-writer.service";
import { GoogleSyncRunnerService } from "../apps/api/src/daily-sync/google-sync-runner.service";
import { validGoogleCreatives } from "../apps/api/src/domain/google-creative-metrics";
import { GoogleReadService } from "../apps/api/src/google/google-read.service";

// Explicit production target, one normal leased/manual publication per existing API day.
// No source policy changes, no direct fact updates, no modification of other providers.
process.env.PRISMA_CONNECTION_LIMIT = "1";
const { db, close } = productionCafe24Db();
const connectionId = "21b811a6-b9d7-44f5-8167-ce40198947b5";
const apply = process.argv.includes("--apply"), smoke = process.argv.includes("--smoke");
const output = `reports/google-creative-rollout-20261105/${apply ? "backfill" : "preview"}-${Date.now()}`;
mkdirSync(output, { recursive: true });
async function main() {
  const connection = await db.sourceConnection.findUniqueOrThrow({ where: { id: connectionId } });
  assert(connection.provider === "GOOGLE" && connection.externalAccountId === "1391592099" && connection.enabled && connection.accessState === "READY", "ACCOUNT_SCOPE");
  assert(process.env.DAILY_SYNC_GOOGLE_CREDENTIAL_REF === connection.credentialRef, "CREDENTIAL_BINDING");
  const days = await db.googleCampaignDailyCost.findMany({ where: { connectionId, source: "API", isCurrent: true },
    select: { metricDate: true }, distinct: ["metricDate"], orderBy: { metricDate: "asc" } });
  assert(days.length > 0 && days.length <= 366, "BACKFILL_BOUND");
  const selected = smoke ? days.slice(-1) : days;
  const auth = process.env.DAILY_SYNC_GOOGLE_ADC_JSON_B64
    ? new GoogleAuth({ credentials: JSON.parse(Buffer.from(process.env.DAILY_SYNC_GOOGLE_ADC_JSON_B64, "base64").toString("utf8")), scopes: ["https://www.googleapis.com/auth/adwords"] })
    : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/adwords"] });
  const client = new GoogleAdsClient(auth);
  const foundation = new SyncFoundationService(db, new HeavyOperationGate({ heavyOperationConcurrency: 1 } as never, new Reflector()));
  const runner = new GoogleSyncRunnerService(db, foundation, client, new GoogleCanonicalWriterService(foundation));
  const results: unknown[] = [];
  for (const { metricDate } of selected) {
    const day = metricDate.toISOString().slice(0, 10);
    if (!apply) {
      const snapshot = await client.fetchDay({ customerId: connection.externalAccountId, day, deadlineAt: Date.now() + 120_000,
        loginCustomerId: process.env.DAILY_SYNC_GOOGLE_LOGIN_CUSTOMER_ID });
      assert(snapshot.rows.every(row => validGoogleCreatives(row.creativeMetrics, row)), "CHILD_RECONCILIATION");
      results.push({ day, status: "READ_VERIFIED", campaigns: snapshot.rows.length,
        creatives: snapshot.rows.reduce((n, row) => n + row.creativeMetrics!.ads.length, 0), costMicros: snapshot.accountCostMicros.toString() });
      writeFileSync(`${output}/${day}.json`, JSON.stringify(snapshot, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
    } else {
      const run = await foundation.queueRun({ connectionId, fromDate: day, toDate: day, trigger: "MANUAL",
        requestKey: `google-creative-v1-${day}-${randomUUID()}`, actorUserId: null });
      const final = await runner.execute(run.id);
      assert(final.status === "SUCCEEDED", `BACKFILL_DAY_${day}_${final.safeErrorCode ?? final.status}`);
      const rows = await db.googleCampaignDailyCost.findMany({ where: { connectionId, metricDate, source: "API", isCurrent: true } });
      assert(rows.every(row => validGoogleCreatives(row.creativeMetrics, row)), "STORED_CHILD_RECONCILIATION");
      results.push({ day, status: final.status, runId: run.id, campaigns: rows.length,
        creatives: rows.reduce((n, row) => n + (validGoogleCreatives(row.creativeMetrics, row) ? row.creativeMetrics.ads.length : 0), 0),
        costMicros: rows.reduce((n, row) => n + row.costMicros, 0n).toString() });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ apply, results }, null, 2));
    console.log(JSON.stringify(results.at(-1)));
  }
  if (apply) {
    const reader = new GoogleReadService(db);
    for (const { metricDate } of days.slice(-2)) {
      const day = metricDate.toISOString().slice(0, 10);
      const report = await reader.report({ from: day, to: day, pageSize: 100 }, "creatives");
      assert(report.creativeCompleteness?.complete, "REPORT_CREATIVE_COMPLETENESS");
      writeFileSync(`${output}/report-${day}.json`, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ reportDay: day, creativeComplete: true, creativeCount: report.pagination.total }));
    }
  }
  console.log(JSON.stringify({ status: "COMPLETE", apply, days: results.length, output }));
}
main().catch(error => {
  console.error(JSON.stringify({ status: "FAILED", code: error?.safeCode ?? error?.code ?? error?.getResponse?.()?.code ??
    (error?.code === "ERR_ASSERTION" ? error?.message : "GOOGLE_CREATIVE_BACKFILL_FAILED") }));
  process.exitCode = 1;
}).finally(close);
