import { randomUUID } from "node:crypto";
import { PrismaClient, SyncTrigger } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { CredentialVault } from "./credential-vault";
import { GoogleAdsClient } from "./google-ads.client";
import { GoogleCanonicalWriterService } from "./google-canonical-writer.service";
import { GoogleConnectionVerifierService } from "./google-connection-verifier.service";
import { GoogleSyncRunnerService } from "./google-sync-runner.service";
import { SyncFoundationService } from "./sync-foundation.service";
import { SAFE_SYNC_CODES } from "./sync-contract";
import { completeVerificationCoverage, verificationRequestKey } from "./google-isolated-verify.support";

/** Manual, opt-in 05 evidence harness. It refuses every DB except the local isolated phase03 target. */
async function main() {
  const rawUrl = process.env.DAILY_SYNC_INTEGRATION_DATABASE_URL;
  const url = rawUrl ? new URL(rawUrl) : null;
  if (!url || url.hostname !== "127.0.0.1" || url.port !== "55433" ||
      url.pathname !== "/phase03" || url.searchParams.get("schema") !== "meta_ads")
    throw new Error("ISOLATED_DATABASE_REQUIRED");
  const customerId = process.env.GOOGLE_ADS_VERIFICATION_CUSTOMER_ID;
  const fromDate = process.env.GOOGLE_ADS_VERIFICATION_FROM;
  const toDate = process.env.GOOGLE_ADS_VERIFICATION_TO;
  const verificationDay = process.env.GOOGLE_ADS_VERIFICATION_UI_DAY;
  const observedAccountCostKrw = process.env.GOOGLE_ADS_VERIFICATION_UI_COST_KRW;
  if (!customerId || !/^\d{10}$/.test(customerId) || !fromDate || !toDate ||
      !verificationDay || !observedAccountCostKrw)
    throw new Error("VERIFICATION_INPUT_REQUIRED");
  // This legacy 05 harness once accepted a seven-day evidence run. New manual
  // runs are single-day; reject an old range before binding credentials.
  if (fromDate !== toDate) throw new Error("SINGLE_DAY_VERIFICATION_REQUIRED");
  const prisma = new PrismaClient({ datasourceUrl: rawUrl });
  try {
    process.env.DAILY_SYNC_FEATURE_ENABLED = "true";
    process.env.DAILY_SYNC_ALLOWED_ACCOUNTS = JSON.stringify([`GOOGLE/${customerId}/default`]);
    let connection = await prisma.sourceConnection.findUnique({ where: {
      provider_externalAccountId_shopKey: {
        provider: "GOOGLE", externalAccountId: customerId, shopKey: "default"
      }
    } });
    if (!connection) connection = await prisma.sourceConnection.create({ data: {
      provider: "GOOGLE", externalAccountId: customerId, shopKey: "default",
      displayName: "Google Ads isolated verification", currencyCode: "KRW",
      timeZone: "Asia/Seoul", accessState: "PENDING", enabled: false
    } });
    process.env.DAILY_SYNC_GOOGLE_CREDENTIAL_REF = connection.credentialRef ??
      `vault://google/${randomUUID()}`;
    const db = prisma as unknown as PrismaService;
    const client = new GoogleAdsClient();
    const gate = { tryAcquire: () => ({ release: () => undefined }) };
    const foundation = new SyncFoundationService(db, gate as never);
    const verifier = new GoogleConnectionVerifierService(db, new CredentialVault(db), client);
    await verifier.bindConfiguredAuth(connection.id, null);
    await verifier.verifyAndActivate({ connectionId: connection.id, verificationDay,
      observedAccountCostKrw, fromDate, actorUserId: null });
    const run = await foundation.queueRun({ connectionId: connection.id,
      fromDate, toDate, trigger: SyncTrigger.MANUAL,
      requestKey: verificationRequestKey(fromDate, toDate), actorUserId: null });
    const writer = new GoogleCanonicalWriterService(foundation);
    const runner = new GoogleSyncRunnerService(db, foundation, client, writer);
    const final = run.status === "SUCCEEDED" ? run : await runner.execute(run.id);
    const coverage = await prisma.sourceCoverage.findMany({ where: {
      connectionId: connection.id, dataKind: "GOOGLE_CAMPAIGN",
      metricDate: { gte: new Date(`${fromDate}T00:00:00Z`),
        lte: new Date(`${toDate}T00:00:00Z`) }
    }, orderBy: { metricDate: "asc" } });
    const summary = { target: "127.0.0.1:55433/phase03/meta_ads",
      customerId, connectionId: connection.id, runId: run.id,
      status: final.status, rowsFetched: final.rowsFetched,
      rowsPublished: final.rowsPublished,
      coverage: coverage.map((item) => ({ day: item.metricDate.toISOString().slice(0, 10),
        state: item.state, rowCount: item.rowCount,
        totalAmount: item.totalAmount?.toString() ?? null,
        warningCodes: item.warningCodes })) };
    process.stdout.write(JSON.stringify(summary) + "\n");
    if (final.status !== "SUCCEEDED" || !completeVerificationCoverage(run, coverage))
      process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const rawCode = error && typeof error === "object" && "safeCode" in error ? error.safeCode : null;
  const safeCode = typeof rawCode === "string" && SAFE_SYNC_CODES.has(rawCode)
    ? rawCode : "VERIFICATION_FAILED";
  process.stdout.write(JSON.stringify({ code: safeCode }) + "\n");
  process.exitCode = 1;
});
