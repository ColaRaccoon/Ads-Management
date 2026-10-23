// Full Cafe24 canonical pointers created by the real writer, with synthetic
// inputs only. The rollback below is a guarded local rehearsal, not a remote CLI.
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Reflector } from "@nestjs/core";
import { Prisma, SyncTrigger } from "@prisma/client";
import { PrismaService } from "../../../apps/api/src/common/prisma.service";
import { HeavyOperationGate } from "../../../apps/api/src/common/heavy-operation";
import { SyncFoundationService } from "../../../apps/api/src/daily-sync/sync-foundation.service";
import { Cafe24CanonicalWriterService } from "../../../apps/api/src/daily-sync/cafe24-canonical-writer.service";
import { persistCafe24CanonicalLine } from "../../../apps/api/src/daily-sync/cafe24-canonical-persistence";
import { linkBoundCsvVersion, resolveCsvWritePolicy } from "../../../apps/api/src/daily-sync/canonical-write-policy";
import type { Cafe24ApiOrder } from "../../../apps/api/src/daily-sync/cafe24-api-order";

const raw = process.env.PHASE10_API_SYNTHETIC_TEST_URL;
test("real Cafe24 writer before-image CAS restores version/line/link/coverage and preserves newer CSV/policy/user history", { skip: !raw }, async () => {
  assert(raw); const url = new URL(raw); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55434"); assert.equal(url.pathname, "/phase10_api_synthetic_20261019"); assert.equal(url.searchParams.get("schema"), "meta_ads");
  const saved = { ...process.env }, account = `phase10-before-image-${randomUUID()}`, day = "2026-10-17", at = new Date(`${day}Z`);
  Object.assign(process.env, { DATABASE_URL: raw, PRISMA_IDLE_DISCONNECT_MS: "0", DAILY_SYNC_FEATURE_ENABLED: "true",
    DAILY_SYNC_ALLOWED_ACCOUNTS: JSON.stringify([`CAFE24/${account}/shop1`]), DAILY_SYNC_CREDENTIAL_KEY_V1: randomBytes(32).toString("base64"),
    DAILY_SYNC_CAFE24_APP_API_VERSION: "2026-09-01", DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT: "2026-10-19",
    DAILY_SYNC_CAFE24_SELLER_DROPDOWN: "true", DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT: "2026-10-19", DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES: '["N30"]' });
  const db = new PrismaService(), foundation = new SyncFoundationService(db, new HeavyOperationGate({ heavyOperationConcurrency: 1 } as any, new Reflector()));
  const writer = new Cafe24CanonicalWriterService(db, foundation);
  const restoreEnv = ["DATABASE_URL", "PRISMA_IDLE_DISCONNECT_MS", "DAILY_SYNC_FEATURE_ENABLED", "DAILY_SYNC_ALLOWED_ACCOUNTS", "DAILY_SYNC_CREDENTIAL_KEY_V1", "DAILY_SYNC_CAFE24_APP_API_VERSION", "DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT", "DAILY_SYNC_CAFE24_SELLER_DROPDOWN", "DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT", "DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES"];
  const stable = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value) : value instanceof Date ? JSON.stringify(value.toISOString()) : Prisma.Decimal.isDecimal(value) ? JSON.stringify(value.toString()) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  const digest = (value: any) => createHash("sha256").update(stable(value)).digest("hex");
  try {
    const user = await db.appUser.create({ data: { name: "Synthetic rollback administrator", role: "SUPER_ADMIN" } });
    const product = await db.product.create({ data: { code: `rollback-${randomUUID()}`, name: "Synthetic rollback product", displayName: "Original display" } });
    await db.cafe24ProductRule.create({ data: { productId: product.id, displayName: "Synthetic", productNumbers: ["9000"], optionIncludeKeywords: ["S"], validFrom: new Date("2026-01-01Z") } });
    const c = await db.sourceConnection.create({ data: { provider: "CAFE24", externalAccountId: account, shopKey: "shop1", displayName: "Synthetic writer rollback", currencyCode: "KRW", timeZone: "Asia/Seoul", enabled: true, accessState: "READY", credentialExpiresAt: new Date(Date.now() + 3600000) } });
    const policy = await db.sourcePolicy.create({ data: { connectionId: c.id, dataKind: "CAFE24_ORDER", primarySource: "API", fromDate: at, version: 1, effectiveAt: new Date(), reason: "SYNTHETIC_BASELINE" } });
    const row = (price: string): Cafe24ApiOrder => ({ orderNo: "SYNTHETIC-ORDER", lineOrderNo: "SYNTHETIC-LINE", productNo: "9000", productName: "Synthetic", optionName: "Synthetic(S)", orderedAt: new Date(`${day}T03:00:00Z`), orderDate: at, providerUpdatedAt: null, quantity: "1.0000", salePriceKrw: price, totalOrderKrw: null, totalPaidKrw: price, paymentMethod: null, providerPaymentCodes: ["card"], providerCouponSignal: false, totalPaidInputSource: "ORDERS_PAYMENT_AMOUNT", lineStatus: "N30", orderStatus: "N30" });
    const publish = async (price: string, policyVersion: number) => {
      const run = await foundation.queueRun({ connectionId: c.id, fromDate: day, toDate: day, trigger: SyncTrigger.MANUAL, actorUserId: user.id, requestKey: `phase10-writer:${randomUUID()}` });
      const claim = await foundation.claimRun(run.id, Date.now() + 55000); assert(claim);
      try { assert.equal((await writer.publishCafe24Day({ connectionId: c.id, runId: run.id, generation: claim.generation, metricDate: at, pageCount: 1, policyVersion, completeDaySnapshot: true, fetchedAt: new Date(), orders: [row(price)] })).published, 1); await foundation.finishRun(claim); }
      finally { claim.release(); }
      return run;
    };
    const capture = async (client: any) => ({
      line: await client.cafe24OrderLine.findFirstOrThrow({ where: { connectionId: c.id, source: "API", orderDate: at, isCurrent: true } }),
      version: await client.cafe24OrderApiVersion.findFirstOrThrow({ where: { connectionId: c.id, orderDate: at, isCurrent: true } }),
      link: await client.sourceRecordLink.findFirstOrThrow({ where: { connectionId: c.id, source: "API", dataKind: "CAFE24_ORDER", isCurrent: true } }),
      coverage: await client.sourceCoverage.findUniqueOrThrow({ where: { connectionId_dataKind_metricDate: { connectionId: c.id, dataKind: "CAFE24_ORDER", metricDate: at } } }),
      policy: await client.sourcePolicy.findUniqueOrThrow({ where: { id: policy.id } })
    });
    const firstRun = await publish("100.00", 1), before = await capture(db);
    assert.equal(before.line.productId, product.id); assert.equal(before.version.version, 1); assert.equal(before.link.recordId, before.line.id);
    const batch = await db.cafe24UploadBatch.create({ data: { originalFilename: "synthetic-before-image.csv", fileHashSha256: randomBytes(32).toString("hex"), columnSchema: [], status: "IMPORTED", rowCount: 1 } });
    const csvData = { uploadBatchId: batch.id, rowNumber: 1, sourceRowHash: randomBytes(32).toString("hex"), connectionId: c.id, source: "CSV" as const,
      orderLineKey: before.line.orderLineKey, orderNo: "SYNTHETIC-ORDER", lineOrderNo: "SYNTHETIC-LINE", productNo: "9000", productName: "Synthetic", optionName: "Synthetic(S)", quantity: new Prisma.Decimal(1), salePriceKrw: new Prisma.Decimal(100), totalPaidKrw: new Prisma.Decimal(100), orderDate: at, productId: product.id, isCurrent: true };
    const csv1 = await db.cafe24OrderLine.create({ data: csvData });
    await db.$transaction(tx => linkBoundCsvVersion(tx, { connectionId: c.id, dataKind: "CAFE24_ORDER", keyParts: [c.id, "SYNTHETIC-ORDER", "SYNTHETIC-LINE", "9000", "Synthetic(S)"], recordTable: "cafe24_order_lines", recordId: csv1.id, version: 1 }));
    const secondRun = await publish("110.00", 1), after = await capture(db);
    assert.equal(after.version.version, 2); assert.equal(after.line.importVersion, 2); assert.equal(after.link.version, 2);
    await db.sourcePolicy.update({ where: { id: policy.id }, data: { primarySource: "CSV", version: 2, reason: "USER_LATER_SOURCE_EDIT", changedByUserId: user.id } });
    const csv2 = await db.$transaction(async tx => {
      const selection = await resolveCsvWritePolicy(tx, { provider: "CAFE24", dataKind: "CAFE24_ORDER", dates: [at], sourceConnectionId: c.id }); assert(selection.primaryDates.has(day));
      const line = await persistCafe24CanonicalLine(tx, { source: "CSV", connectionId: c.id, orderLineKey: csv1.orderLineKey, previousCurrentIds: [csv1.id], data: { ...csvData, rowNumber: 2, sourceRowHash: randomBytes(32).toString("hex"), salePriceKrw: new Prisma.Decimal(149), totalPaidKrw: new Prisma.Decimal(149), importVersion: 2 } });
      await linkBoundCsvVersion(tx, { connectionId: c.id, dataKind: "CAFE24_ORDER", keyParts: [c.id, "SYNTHETIC-ORDER", "SYNTHETIC-LINE", "9000", "Synthetic(S)"], recordTable: "cafe24_order_lines", recordId: line.id, version: 2 });
      await tx.cafe24UploadBatch.update({ where: { id: batch.id }, data: { rowCount: 2 } }); return line;
    });
    await db.product.update({ where: { id: product.id }, data: { displayName: "USER_LATER_PRODUCT_EDIT" } });
    const beforeThird = await capture(db), thirdRun = await publish("120.00", 2), third = await capture(db);
    assert.equal(third.version.version, 3);
    const manifests = [{ before, after }, { before: beforeThird, after: third }];
    if (process.env.PHASE10_API_BEFORE_IMAGE_EVIDENCE) writeFileSync(process.env.PHASE10_API_BEFORE_IMAGE_EVIDENCE, JSON.stringify({ kind: "SYNTHETIC_FULL_CAFE_POINTER_MANIFEST", manifests }, null, 2) + "\n", { flag: "wx" });
    const rollback = async (manifest: any) => db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM source_connections WHERE id=${c.id}::uuid FOR UPDATE`);
      assert.equal(await tx.syncLease.count({ where: { connectionId: c.id, expiresAt: { gt: new Date() } } }), 0);
      const current = await capture(tx);
      assert.equal(current.line.id, manifest.after.line.id, "STALE_MANIFEST_CURRENT_LINE");
      assert.equal(current.version.id, manifest.after.version.id, "STALE_MANIFEST_CURRENT_VERSION");
      assert.equal(current.link.id, manifest.after.link.id, "STALE_MANIFEST_CURRENT_LINK");
      assert.equal(current.coverage.lastSuccessRunId, manifest.after.coverage.lastSuccessRunId, "STALE_MANIFEST_COVERAGE");
      assert.equal(digest({ ...current.line, isCurrent: undefined }), digest({ ...manifest.after.line, isCurrent: undefined }));
      assert.equal(digest({ ...current.version, isCurrent: undefined }), digest({ ...manifest.after.version, isCurrent: undefined }), "CURRENT_VERSION_CHANGED");
      assert.equal(digest({ ...current.link, isCurrent: undefined }), digest({ ...manifest.after.link, isCurrent: undefined }), "CURRENT_LINK_CHANGED");
      const coverageContent = (value: any) => ({ ...value, lastAttemptRunId: undefined, lastAttemptAt: undefined,
        warningCodes: value.warningCodes.filter((code: string) => code !== "SYNTHETIC_MANIFEST_ROLLBACK") });
      assert.equal(digest(coverageContent(current.coverage)), digest(coverageContent(manifest.after.coverage)), "CURRENT_COVERAGE_CHANGED");
      const original = await tx.cafe24OrderLine.findUniqueOrThrow({ where: { id: manifest.before.line.id } });
      assert.equal(original.isCurrent, false); assert.equal(original.supersededByOrderLineId, manifest.after.line.id);
      const lineContent = (value: any) => ({ ...value, isCurrent: undefined, supersededByOrderLineId: undefined });
      assert.equal(digest(lineContent(original)), digest(lineContent(manifest.before.line)), "BEFORE_IMAGE_LINE_CHANGED");
      const originalVersion = await tx.cafe24OrderApiVersion.findUniqueOrThrow({ where: { id: manifest.before.version.id } });
      assert.equal(originalVersion.isCurrent, false);
      assert.equal(digest({ ...originalVersion, isCurrent: undefined }), digest({ ...manifest.before.version, isCurrent: undefined }), "BEFORE_IMAGE_VERSION_CHANGED");
      const originalLink = await tx.sourceRecordLink.findUniqueOrThrow({ where: { id: manifest.before.link.id } });
      assert.equal(originalLink.isCurrent, false);
      assert.equal(digest({ ...originalLink, isCurrent: undefined }), digest({ ...manifest.before.link, isCurrent: undefined }), "BEFORE_IMAGE_LINK_CHANGED");
      assert.equal((await tx.cafe24OrderLine.updateMany({ where: { id: current.line.id, connectionId: c.id, source: "API", isCurrent: true, importVersion: manifest.after.line.importVersion, syncRunId: manifest.after.line.syncRunId }, data: { isCurrent: false } })).count, 1);
      assert.equal((await tx.cafe24OrderApiVersion.updateMany({ where: { id: current.version.id, connectionId: c.id, isCurrent: true, version: manifest.after.version.version, syncRunId: manifest.after.version.syncRunId }, data: { isCurrent: false } })).count, 1);
      assert.equal((await tx.sourceRecordLink.updateMany({ where: { id: current.link.id, connectionId: c.id, source: "API", isCurrent: true, version: manifest.after.link.version }, data: { isCurrent: false } })).count, 1);
      assert.equal((await tx.cafe24OrderLine.updateMany({ where: { id: original.id, connectionId: c.id, source: "API", isCurrent: false, supersededByOrderLineId: current.line.id }, data: { isCurrent: true, supersededByOrderLineId: manifest.before.line.supersededByOrderLineId } })).count, 1);
      assert.equal((await tx.cafe24OrderApiVersion.updateMany({ where: { id: manifest.before.version.id, connectionId: c.id, isCurrent: false, version: manifest.before.version.version }, data: { isCurrent: true } })).count, 1);
      assert.equal((await tx.sourceRecordLink.updateMany({ where: { id: manifest.before.link.id, connectionId: c.id, source: "API", isCurrent: false, version: manifest.before.link.version }, data: { isCurrent: true } })).count, 1);
      const old = manifest.before.coverage;
      assert.equal((await tx.sourceCoverage.updateMany({ where: { connectionId: c.id, dataKind: "CAFE24_ORDER", metricDate: at, lastSuccessRunId: current.coverage.lastSuccessRunId }, data: {
        source: old.source, state: old.state, lastSuccessRunId: old.lastSuccessRunId, lastSuccessAt: old.lastSuccessAt, rowCount: old.rowCount, totalAmount: old.totalAmount,
        reconciliationStatus: old.reconciliationStatus, warningCodes: [...old.warningCodes, "SYNTHETIC_MANIFEST_ROLLBACK"]
      } })).count, 1);
      // The later user's CSV policy is preserved; never replace a newer version.
      if (current.policy.version === manifest.after.policy.version && current.policy.primarySource === manifest.after.policy.primarySource && current.policy.version !== manifest.before.policy.version) {
        await tx.sourcePolicy.updateMany({ where: { id: policy.id, version: current.policy.version }, data: { primarySource: manifest.before.policy.primarySource, version: current.policy.version + 1, reason: "SYNTHETIC_ROLLBACK" } });
      }
      await tx.securityAuditEvent.create({ data: { actorType: "USER", actorUserId: user.id, action: "SYNTHETIC_SOURCE_ROLLBACK", targetType: "SOURCE_CONNECTION", targetId: c.id, result: "SUCCESS",
        afterJson: { manifestBeforeSha256: digest(manifest.before), manifestAfterSha256: digest(manifest.after), restoredVersion: manifest.before.version.version, latestAttemptPreserved: true } } });
    }, { isolationLevel: "Serializable", timeout: 10000 });
    await assert.rejects(rollback(manifests[0]), /STALE_MANIFEST_CURRENT_LINE/);
    assert.equal((await capture(db)).line.id, third.line.id);
    const rejectTamper = async (change: () => Promise<unknown>, restore: () => Promise<unknown>, reason: string) => {
      await change(); await assert.rejects(rollback(manifests[1]), new RegExp(reason));
      assert.equal((await capture(db)).line.id, third.line.id); await restore();
    };
    await rejectTamper(() => db.cafe24OrderLine.update({ where: { id: after.line.id }, data: { productName: "SYNTHETIC_TAMPER" } }),
      () => db.cafe24OrderLine.update({ where: { id: after.line.id }, data: { productName: after.line.productName } }), "BEFORE_IMAGE_LINE_CHANGED");
    await rejectTamper(() => db.cafe24OrderApiVersion.update({ where: { id: third.version.id }, data: { salePriceKrw: new Prisma.Decimal(121) } }),
      () => db.cafe24OrderApiVersion.update({ where: { id: third.version.id }, data: { salePriceKrw: third.version.salePriceKrw } }), "CURRENT_VERSION_CHANGED");
    await rejectTamper(() => db.cafe24OrderApiVersion.update({ where: { id: after.version.id }, data: { contentFingerprint: "0".repeat(64) } }),
      () => db.cafe24OrderApiVersion.update({ where: { id: after.version.id }, data: { contentFingerprint: after.version.contentFingerprint } }), "BEFORE_IMAGE_VERSION_CHANGED");
    await rejectTamper(() => db.sourceRecordLink.update({ where: { id: third.link.id }, data: { bindingMethod: "REVIEWED_LEGACY" } }),
      () => db.sourceRecordLink.update({ where: { id: third.link.id }, data: { bindingMethod: third.link.bindingMethod } }), "CURRENT_LINK_CHANGED");
    await rejectTamper(() => db.sourceRecordLink.update({ where: { id: after.link.id }, data: { syncRunId: firstRun.id } }),
      () => db.sourceRecordLink.update({ where: { id: after.link.id }, data: { syncRunId: after.link.syncRunId } }), "BEFORE_IMAGE_LINK_CHANGED");
    await rejectTamper(() => db.sourceCoverage.update({ where: { connectionId_dataKind_metricDate: { connectionId: c.id, dataKind: "CAFE24_ORDER", metricDate: at } }, data: { state: "FAILED" } }),
      () => db.sourceCoverage.update({ where: { connectionId_dataKind_metricDate: { connectionId: c.id, dataKind: "CAFE24_ORDER", metricDate: at } }, data: { state: third.coverage.state } }), "CURRENT_COVERAGE_CHANGED");
    await rollback(manifests[1]); assert.equal((await capture(db)).line.id, after.line.id);
    await rollback(manifests[0]); const restored = await capture(db);
    assert.equal(restored.line.id, before.line.id); assert.equal(restored.line.salePriceKrw.toString(), "100"); assert.equal(restored.line.supersededByOrderLineId, null);
    assert.equal(restored.version.id, before.version.id); assert.equal(restored.link.id, before.link.id); assert.equal(restored.link.recordId, before.line.id);
    assert.equal(restored.coverage.lastSuccessRunId, firstRun.id); assert.equal(restored.coverage.lastAttemptRunId, thirdRun.id); assert(restored.coverage.warningCodes.includes("SYNTHETIC_MANIFEST_ROLLBACK"));
    assert.equal(restored.policy.primarySource, "CSV"); assert.equal(restored.policy.version, 2);
    assert.equal((await db.cafe24OrderLine.findUniqueOrThrow({ where: { id: csv2.id } })).isCurrent, true);
    assert.equal((await db.cafe24OrderLine.findUniqueOrThrow({ where: { id: csv2.id } })).salePriceKrw.toString(), "149");
    assert.equal((await db.sourceRecordLink.findFirstOrThrow({ where: { connectionId: c.id, source: "CSV", isCurrent: true } })).recordId, csv2.id);
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: product.id } })).displayName, "USER_LATER_PRODUCT_EDIT");
    assert.equal(await db.cafe24OrderApiVersion.count({ where: { connectionId: c.id } }), 3); assert.equal(await db.cafe24OrderLine.count({ where: { connectionId: c.id, source: "API" } }), 3);
    for (const run of [firstRun, secondRun, thirdRun]) assert.equal(await db.securityAuditEvent.count({ where: { action: "SYNC_UNIT_PUBLISHED", targetId: `${run.id}:${day}` } }), 1);
    assert.equal(await db.securityAuditEvent.count({ where: { action: "SYNTHETIC_SOURCE_ROLLBACK", targetId: c.id } }), 2);
    console.log(JSON.stringify({ kind: "PHASE10_REAL_PG_SYNTHETIC_CAFE_BEFORE_IMAGE", providerRequests: 0, actualCanonicalWriter: true, actualFencedPublication: true,
      publishedVersions: 3, staleManifestRejectedAtomically: true, restoredApiVersion: 1, currentLineVersionLinkCoverageCoherent: true, latestAttemptPreserved: true,
      laterCsvVersion: 2, laterCsvLinkPreserved: true, laterCsvAmount: "149", laterUserPolicyVersion: 2, laterUserProductEditPreserved: true, publicationAuditsPreserved: 3,
      fullImmutableContentGuards: true, tamperRejections: 6, rollbackAudits: 2, deletedRows: 0, fullDatabaseRestore: false, actualImageRollbackVerified: false, testedBusinessKeys: 1 }));
  } finally { await db.$disconnect(); for (const key of restoreEnv) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
