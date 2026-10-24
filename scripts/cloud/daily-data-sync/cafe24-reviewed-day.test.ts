import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { SourceConnectionsService } from "../../../apps/api/src/daily-sync/source-connections.service";
import { SourceConnectionsController } from "../../../apps/api/src/daily-sync/daily-sync.controller";
import { computeCafe24ActivationEvidence } from "../../../apps/api/src/daily-sync/cafe24-activation-evidence";
import { cafe24ProductPrefixSpaceDifference } from "../../../apps/api/src/daily-sync/cafe24-reviewed-parity";
import { cafe24ManualActivationPreview } from "../../../apps/api/src/daily-sync/cafe24-manual-preparation";

const connectionId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const day = "2026-10-23", date = new Date(`${day}T00:00:00Z`);
const decimal = (value: number) => new Prisma.Decimal(value);
const rawKey = (row: any) => [connectionId, row.orderNo, row.lineOrderNo, row.productNo, row.optionName];
const hash = (row: any) => createHash("sha256").update(JSON.stringify(rawKey(row))).digest("hex");

async function environment(work: () => Promise<void>) {
  const original = { ...process.env };
  Object.assign(process.env, {
    DAILY_SYNC_FEATURE_ENABLED: "true", DAILY_SYNC_CAFE24_DAY_ACTIVATION_ENABLED: "true",
    DAILY_SYNC_SCHEDULE_ENABLED: "false", DAILY_SYNC_ALLOWED_ACCOUNTS: '["CAFE24/review-mall/shop1"]',
    DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION: "2",
    DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64: Buffer.alloc(32, 37).toString("base64")
  });
  delete process.env.DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED;
  try { await work(); } finally { process.env = original; }
}

function fixture() {
  const state: any = { lines: [], versions: [], links: [], policies: [], audits: [], failUpdate: false };
  for (let index = 1; index <= 2; index++) {
    const row: any = {
      id: `api-${index}`, connectionId, source: "API", isCurrent: true,
      orderNo: `synthetic-order-${index}`, lineOrderNo: `synthetic-item-${index}`, productNo: "69",
      productName: "상품 이름", optionName: "상품 이름(색상=검정)",
      quantity: decimal(1), salePriceKrw: decimal(1000), totalOrderKrw: null, totalPaidKrw: decimal(1000),
      paymentMethod: "신용카드", providerPaymentCodes: ["credit"], providerCouponSignal: false,
      actualOrderPriceKrw: decimal(1000), actualPaymentKrw: decimal(1000), actualShippingFeeKrw: decimal(0),
      initialOrderPriceKrw: decimal(1000), initialPaymentKrw: decimal(1000), initialShippingFeeKrw: decimal(0),
      totalPaidInputSource: "ORDERS_PAYMENT_AMOUNT", orderedAt: new Date(`${day}T01:00:00Z`), orderDate: date,
      productId: index === 1 ? null : "product-69", cafe24ProductRuleId: index === 1 ? null : "rule-69",
      matchSource: index === 1 ? "UNMATCHED" : "RULE", validationStatus: index === 1 ? "UNMATCHED" : "VALID",
      importVersion: 1, syncRunId: runId
    };
    row.orderLineKey = JSON.stringify(rawKey(row));
    state.lines.push(row);
    state.versions.push({ ...row, canonicalKeyHash: hash(row), version: 1,
      fetchedAt: new Date("2026-10-24T00:00:00Z"), contentFingerprint: "c".repeat(64), fingerprintKeyVersion: 2 });
    const csv: any = { ...row, id: `csv-${index}`, source: "CSV", totalOrderKrw: decimal(1000),
      productName: index === 1 ? "상품  이름" : row.productName,
      optionName: index === 1 ? "상품  이름(색상=검정)" : row.optionName,
      productId: "product-69", cafe24ProductRuleId: "rule-69", matchSource: "RULE", validationStatus: "VALID",
      orderDate: index === 1 ? null : date, orderedAt: index === 1 ? null : row.orderedAt };
    csv.orderLineKey = [csv.orderNo, csv.lineOrderNo, csv.productNo, csv.optionName].join(":");
    state.lines.push(csv);
    for (const current of [row, csv]) state.links.push({ id: `link-${current.id}`, connectionId,
      source: current.source, recordId: current.id, recordTable: "cafe24_order_lines", dataKind: "CAFE24_ORDER",
      canonicalKeyHash: hash(current), version: 1, isCurrent: true });
  }
  state.policies.push({ id: "policy-1", connectionId, dataKind: "CAFE24_ORDER", primarySource: "CSV",
    version: 1, fromDate: date, toDate: null, couponInputSource: "UNKNOWN" });
  state.coverage = { connectionId, dataKind: "CAFE24_ORDER", metricDate: date, source: "API",
    state: "COMPLETE_NONZERO", rowCount: 2, lastSuccessRunId: runId, lastAttemptRunId: runId,
    lastSuccessAt: new Date("2026-10-24T00:01:00Z"),
    warningCodes: ["CAFE24_SHADOW_NOT_PRIMARY", "CAFE24_PRODUCT_MAPPING_INCOMPLETE"] };
  const run = { id: runId, connectionId, status: "SUCCEEDED", fromDate: date, toDate: date,
    rowsFetched: 2, rowsPublished: 2, finishedAt: state.coverage.lastSuccessAt, trigger: "MANUAL" };
  const rule = { id: "rule-69", productId: "product-69", displayName: "상품", productNumbers: ["69"],
    productNameAliases: [], optionIncludeKeywords: [], optionExcludeKeywords: [], priority: 100,
    validFrom: date, validTo: null, isActive: true, adCostSourceProductId: null, roasGroup: null };
  const db: any = {
    sourceConnection: { findUnique: async () => ({ id: connectionId, provider: "CAFE24", externalAccountId: "review-mall",
      shopKey: "shop1", currencyCode: "KRW", timeZone: "Asia/Seoul" }) },
    sourcePolicy: { findMany: async ({ where }: any) => state.policies.filter((r: any) =>
      !where?.fromDate?.lte || r.fromDate <= where.fromDate.lte && (!r.toDate || r.toDate > where.fromDate.lte)),
      update: async ({ where, data }: any) => Object.assign(state.policies.find((r: any) => r.id === where.id), data),
      create: async ({ data }: any) => { state.policies.push({ id: "policy-2", ...data }); return data; } },
    sourceCoverage: { findUnique: async ({ where }: any) =>
      state.historicCoverage?.metricDate.getTime() === where.connectionId_dataKind_metricDate.metricDate.getTime()
        ? state.historicCoverage : state.coverage,
      findMany: async () => state.historicCoverage ? [state.historicCoverage] : [state.coverage],
      update: async ({ data }: any) => Object.assign(state.coverage, data) },
    syncRun: { findUnique: async ({ where }: any) => state.nextRun?.id === where.id ? state.nextRun : run }, runUnit: { findUnique: async () => ({ status: "SUCCEEDED", publishedCount: 2 }) },
    cafe24OrderLine: { count: async () => 0,
      findMany: async ({ where }: any) => state.lines.filter((r: any) => {
        if (where.source && r.source !== where.source) return false;
        if (where.orderDate === null) return r.orderDate === null;
        if (where.orderDate instanceof Date) return r.orderDate?.getTime() === where.orderDate.getTime();
        if (where.orderDate?.lt) return r.orderDate && r.orderDate < where.orderDate.lt &&
          (!where.orderNo?.in || where.orderNo.in.includes(r.orderNo));
        if (where.OR) return where.OR.some((part: any) => part.orderDate === null
          ? r.orderDate === null && r.source === part.source
          : r.orderDate?.getTime() === part.orderDate?.getTime());
        return true;
      }).sort((a: any, b: any) => a.id.localeCompare(b.id)),
      updateMany: async ({ where, data }: any) => {
        if (state.failUpdate) return { count: 0 };
        const rows = state.lines.filter((r: any) => where.id.in.includes(r.id) && r.source === where.source);
        rows.forEach((r: any) => Object.assign(r, data)); return { count: rows.length };
      } },
    cafe24OrderApiVersion: { findMany: async ({ where }: any) => state.versions.filter((r: any) =>
      r.orderDate?.getTime() === where.orderDate?.getTime()) },
    cafe24ProductRule: { findMany: async () => [rule] },
    sourceRecordLink: { findMany: async ({ where }: any) => state.links.filter((r: any) =>
      (!where.source || r.source === where.source) &&
      (!where.canonicalKeyHash?.in || where.canonicalKeyHash.in.includes(r.canonicalKeyHash))),
      findFirst: async ({ where }: any) => state.links.find((r: any) =>
        r.recordId === where.recordId && r.source === where.source &&
        r.canonicalKeyHash === where.canonicalKeyHash && r.version === where.version) },
    securityAuditEvent: { create: async ({ data }: any) => { state.audits.push(data); return data; },
      findFirst: async ({ where }: any) => state.audits.find((r: any) =>
        r.action === where.action && r.afterJson?.day === where.AND[0].afterJson.equals) },
    $queryRaw: async () => [{ id: connectionId, connectionId, orderDate: date, rowCount: 2,
      linkedCount: 2, validLinkedCount: 2, validVersionCount: 2, validMappingCount: 2 }]
  };
  db.$transaction = async (work: any) => {
    const before = { lines: state.lines.map((r: any) => ({ ...r })), policies: state.policies.map((r: any) => ({ ...r })),
      coverage: { ...state.coverage }, audits: [...state.audits] };
    try { return await work(db); } catch (error) { Object.assign(state, before); throw error; }
  };
  const input: any = { day, expectedPolicyVersion: 1, expectedSuccessRunId: runId,
    reason: "HOME_CSV_REVIEWED_DAY", mode: "CSV_REVIEWED", couponInputSource: "API_ACTUAL_PRODUCT_PLUS_SHIPPING",
    expectedOptionPrefixWhitespaceLines: 1, expectedMappingChangeLines: 1,
    expectedInputDifferences: { totalOrderOrders: 2, paidOrders: 0, paymentMethodOrders: 0,
      couponSignalOrders: 0, productNameOrders: 1 } };
  const review = async () => { input.expectedSnapshotDigest = await computeCafe24ActivationEvidence(db, connectionId, day,
    { mode: input.mode, couponInputSource: input.couponInputSource }); };
  return { state, db, input, review, service: new SourceConnectionsService(db) };
}

test("normal preview query produces the same protected scope as activation", async () => environment(async () => {
  const f = fixture();
  const query = { day, mode: f.input.mode, couponInputSource: f.input.couponInputSource };
  const preview = await cafe24ManualActivationPreview(f.db, connectionId, query);
  await f.review();
  assert.equal(preview.snapshotDigest, f.input.expectedSnapshotDigest);
  f.input.expectedSnapshotDigest = preview.snapshotDigest;
  await f.service.activateCafe24Day(connectionId, f.input, actorId);
  assert.equal(f.state.policies[0].primarySource, "API");
}));

test("space review preserves complete option suffixes and item identity", () => {
  const api = { orderNo: "O", lineOrderNo: "L", productNo: "69", productName: "상품 이름", optionName: "상품 이름(색상=검정 A)" };
  const csv = { ...api, optionName: "상품  이름(색상=검정 A)" };
  assert.equal(cafe24ProductPrefixSpaceDifference(api, csv), true);
  for (const change of [{ optionName: "상품  이름(색상=검정  A)" }, { optionName: "상품 다른이름(색상=검정 A)" },
    { productNo: "70" }, { lineOrderNo: "different" }, { optionName: "상품\t이름(색상=검정 A)" }])
    assert.equal(cafe24ProductPrefixSpaceDifference(api, { ...csv, ...change }), false);
});

test("explicit review activates one complete day, refreshes only stale API mapping and preserves original CSV/date/version", async () => environment(async () => {
  const f = fixture(); const originals = JSON.stringify({ csv: f.state.lines.filter((r: any) => r.source === "CSV"), versions: f.state.versions, links: f.state.links });
  await f.review(); const result = await f.service.activateCafe24Day(connectionId, f.input, actorId);
  assert.equal(result.primarySource, "API"); assert.equal(result.policyVersion, 2);
  assert.equal(f.state.lines.find((r: any) => r.id === "api-1").productId, "product-69");
  assert.equal(JSON.stringify({ csv: f.state.lines.filter((r: any) => r.source === "CSV"), versions: f.state.versions, links: f.state.links }), originals);
  assert.equal(f.state.policies[0].toDate.toISOString().slice(0, 10), "2026-10-24");
  assert.equal(f.state.policies[1].primarySource, "CSV");
  assert.equal(f.state.audits[0].action, "CAFE24_MAPPING_REMATCH");
  const after = f.state.audits[1].afterJson;
  assert.equal(after.rematchedApiLines, 1); assert.equal(after.undatedCsvBindings.length, 1);
  assert.equal(after.optionPrefixWhitespaceBindings.length, 1);
  assert.equal(JSON.stringify(after).includes("synthetic-order"), false);
}));

test("missing/count-changed review, option payload changes, stale snapshot and stale CSV rule fit reject without writes", async () => environment(async () => {
  for (const scenario of ["no-space-review", "no-mapping-review", "wrong-count", "wrong-space-count", "payload", "stale", "csv-rule-fit"]) {
    const f = fixture();
    if (scenario === "payload") f.state.lines.find((r: any) => r.id === "csv-1").optionName += "changed";
    await f.review();
    if (scenario === "no-space-review") delete f.input.expectedOptionPrefixWhitespaceLines;
    if (scenario === "no-mapping-review") delete f.input.expectedMappingChangeLines;
    if (scenario === "wrong-count") f.input.expectedMappingChangeLines = 2;
    if (scenario === "wrong-space-count") f.input.expectedOptionPrefixWhitespaceLines = 2;
    if (scenario === "stale") f.state.lines[0].totalPaidKrw = decimal(900);
    if (scenario === "csv-rule-fit") { f.state.lines.find((r: any) => r.id === "csv-1").productId = "wrong-product"; await f.review(); }
    await assert.rejects(f.service.activateCafe24Day(connectionId, f.input, actorId),
      (error: any) => error.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
    assert.equal(f.state.policies[0].primarySource, "CSV", scenario); assert.equal(f.state.audits.length, 0, scenario);
    assert.equal(f.state.lines.find((r: any) => r.id === "api-1").productId, null, scenario);
  }
}));

test("row-update CAS failure rolls back activation and all mapping/audit writes", async () => environment(async () => {
  const f = fixture(); await f.review(); f.state.failUpdate = true;
  await assert.rejects(f.service.activateCafe24Day(connectionId, f.input, actorId),
      (error: any) => error.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
  assert.equal(f.state.policies[0].primarySource, "CSV"); assert.equal(f.state.audits.length, 0);
  assert.equal(f.state.lines.find((r: any) => r.id === "api-1").productId, null);
}));

test("undated near-match is included in the snapshot but cannot authorize changed option contents", async () => environment(async () => {
  const f = fixture(); await f.review(); const original = f.input.expectedSnapshotDigest;
  f.state.lines.find((r: any) => r.id === "csv-1").optionName = "상품  이름(색상=흰색)";
  await f.review(); assert.notEqual(f.input.expectedSnapshotDigest, original);
  await assert.rejects(f.service.activateCafe24Day(connectionId, f.input, actorId),
      (error: any) => error.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
}));

test("mapping refresh needs mappings.manage in addition to the existing route permission", async () => {
  const controller = new SourceConnectionsController({ activateCafe24Day: () => { throw Error("must not call"); } } as any,
    {} as any, {} as any, {} as any, {} as any);
  assert.throws(() => controller.activateCafe24Day({ id: connectionId }, { expectedMappingChangeLines: 1 } as any,
    { id: actorId, permissions: ["settings.manage"] } as any), (error: any) => error.getStatus() === 403);
});

test("default exact CSV and API-only activation keep their previous behavior", async () => environment(async () => {
  for (const mode of ["CSV_REVIEWED", "API_ONLY"]) {
    const f = fixture(); f.input.mode = mode;
    delete f.input.expectedMappingChangeLines; delete f.input.expectedOptionPrefixWhitespaceLines;
    if (mode === "API_ONLY") {
      f.state.lines = f.state.lines.filter((r: any) => r.source === "API");
      f.state.links = f.state.links.filter((r: any) => r.source === "API");
      delete f.input.expectedInputDifferences;
    } else {
      const csv = f.state.lines.find((r: any) => r.id === "csv-1");
      csv.productName = "상품 이름"; csv.optionName = "상품 이름(색상=검정)";
      csv.orderLineKey = [csv.orderNo, csv.lineOrderNo, csv.productNo, csv.optionName].join(":");
      f.state.links.find((r: any) => r.recordId === csv.id).canonicalKeyHash = hash(csv);
      Object.assign(f.state.lines.find((r: any) => r.id === "api-1"), {
        productId: csv.productId, cafe24ProductRuleId: csv.cafe24ProductRuleId,
        matchSource: csv.matchSource, validationStatus: csv.validationStatus
      });
      f.input.expectedInputDifferences.productNameOrders = 0;
    }
    await f.review(); await f.service.activateCafe24Day(connectionId, f.input, actorId);
    assert.equal(f.state.policies[0].primarySource, "API");
    assert.equal(f.state.audits.some((r: any) => r.action === "CAFE24_MAPPING_REMATCH"), false);
  }
}));

test("a later day accepts an original undated space variant only with its earlier protected review and pair binding", async (t) => environment(async () => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T03:00:00Z").getTime() });
  for (const approved of [true, false]) {
    const f = fixture(); await f.review(); await f.service.activateCafe24Day(connectionId, f.input, actorId);
    f.state.historicCoverage = f.state.coverage;
    const next = new Date("2026-10-24T00:00:00Z"), nextRunId = "10000000-0000-4000-8000-000000000004";
    const previousApi = f.state.lines.filter((r: any) => r.source === "API");
    for (const old of previousApi) {
      const row = { ...old, id: `next-${old.id}`, orderNo: `next-${old.orderNo}`, lineOrderNo: `next-${old.lineOrderNo}`,
        orderDate: next, orderedAt: new Date("2026-10-24T01:00:00Z"), syncRunId: nextRunId };
      row.orderLineKey = JSON.stringify(rawKey(row)); f.state.lines.push(row);
      f.state.versions.push({ ...row, canonicalKeyHash: hash(row), version: 1,
        fetchedAt: new Date("2026-10-25T00:00:00Z"), contentFingerprint: "d".repeat(64), fingerprintKeyVersion: 2 });
      const csv = { ...row, id: `next-csv-${row.id}`, source: "CSV", totalOrderKrw: decimal(1000) };
      csv.orderLineKey = [csv.orderNo, csv.lineOrderNo, csv.productNo, csv.optionName].join(":"); f.state.lines.push(csv);
      for (const current of [row, csv]) f.state.links.push({ id: `link-${current.id}`, connectionId,
        source: current.source, recordId: current.id, recordTable: "cafe24_order_lines", dataKind: "CAFE24_ORDER",
        canonicalKeyHash: hash(current), version: 1, isCurrent: true });
    }
    f.state.coverage = { ...f.state.historicCoverage, metricDate: next, lastSuccessRunId: nextRunId,
      lastAttemptRunId: nextRunId, lastSuccessAt: new Date("2026-10-25T00:01:00Z"),
      warningCodes: ["CAFE24_SHADOW_NOT_PRIMARY"], reconciliationStatus: null };
    f.state.nextRun = { id: nextRunId, connectionId, status: "SUCCEEDED", fromDate: next, toDate: next,
      rowsFetched: 2, rowsPublished: 2, finishedAt: f.state.coverage.lastSuccessAt, trigger: "MANUAL" };
    const input = { ...f.input, day: "2026-10-24", expectedSuccessRunId: nextRunId, expectedPolicyVersion: 3,
      expectedMappingChangeLines: 0, expectedOptionPrefixWhitespaceLines: 0,
      expectedInputDifferences: { ...f.input.expectedInputDifferences, productNameOrders: 0 } };
    if (!approved) f.state.audits.find((r: any) => r.action === "SOURCE_POLICY_CHANGED").afterJson.optionPrefixWhitespaceBindings = [];
    input.expectedSnapshotDigest = await computeCafe24ActivationEvidence(f.db, connectionId, input.day,
      { mode: "CSV_REVIEWED", couponInputSource: "API_ACTUAL_PRODUCT_PLUS_SHIPPING" });
    if (approved) {
      const result = await f.service.activateCafe24Day(connectionId, input, actorId);
      assert.equal(result.policyVersion, 4);
    } else {
      await assert.rejects(f.service.activateCafe24Day(connectionId, input, actorId),
        (error: any) => error.getResponse?.().code === "SOURCE_SELECTION_REQUIRED");
      assert.equal(f.state.policies.find((r: any) => r.fromDate.getTime() === next.getTime()).primarySource, "CSV");
    }
    assert.equal(f.state.lines.find((r: any) => r.id === "csv-1").orderDate, null);
  }
}));
