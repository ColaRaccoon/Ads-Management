import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { CoupangService } from "./coupang.service";
import type { PrismaService } from "../common/prisma.service";

const range = { from: "2026-10-01", to: "2026-10-02" }, date = new Date("2026-10-01T00:00:00Z");
function fixture() {
  const product = { id: "p", displayName: "베놈 1개", standardName: "베놈 1개", isActive: true };
  const rule = { id: "r", coupangProductId: "p", displayName: "베놈 1개", includeKeywords: ["베놈", "1개"], excludeKeywords: [],
    priority: 100, isActive: true, adEnabled: true, validFrom: date, validTo: null };
  const line = { id: "sale", uploadBatchId: "batch", saleDate: date, rowNumber: 1, optionId: "123", productName: "베놈", optionName: "1개",
    coupangProductId: "p", coupangProductRuleId: "r", netSalesKrw: 100, validationStatus: "VALID", validationErrors: [] as any[], batch: { originalFilename: "source.xlsx" } };
  const data = { products: [product], rules: [rule], sales: [line], ads: [] as any[], promotions: [] as any[] };
  const calls: any[] = [];
  const table = (key: keyof typeof data) => ({ findMany: async () => data[key], findUnique: async () => data[key][0],
    update: async ({ where, data: patch }: any) => { calls.push({ key, where, patch }); const row = data[key].find((r: any) => r.id === where.id); Object.assign(row!, patch); return row; } });
  const tx = { coupangProduct: table("products"), coupangProductRule: table("rules"), coupangSaleLine: table("sales"),
    coupangAdMetric: table("ads"), coupangPromotionPrice: table("promotions"),
    coupangUploadRowError: { deleteMany: async () => {}, createMany: async () => {} }, securityAuditEvent: { create: async () => {} } };
  const transactions: any[] = [];
  const prisma = { ...tx, $transaction: async (work: (client: typeof tx) => unknown, options: unknown) => { transactions.push(options); return work(tx); } };
  return { data, calls, transactions, service: new CoupangService(prisma as unknown as PrismaService) };
}
test("preview includes correct existing mappings and does not write; unchanged rematch skips writes", async () => {
  const f = fixture();
  const preview = await f.service.previewMappings({ ...range, reviewFilter: "ALL" });
  assert.equal(preview.summary.unchangedCount, 1); assert.equal(preview.rows[0].optionName, "1개"); assert.equal(f.calls.length, 0);
  const result = await f.service.rematch(range, undefined, preview.previewToken!);
  assert.equal(result.updatedRowCount, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.transactions.at(-1).isolationLevel, "Serializable");
});
test("missing and stale previews refuse rematch before any writes", async () => {
  const f = fixture();
  await assert.rejects(f.service.rematch(range), /먼저 전체 매핑 검증/);
  const preview = await f.service.previewMappings(range);
  f.data.sales[0].optionName = "11개";
  await assert.rejects(f.service.rematch(range, undefined, preview.previewToken!), /원천 데이터 또는 규칙/);
  assert.equal(f.calls.length, 0);
});
test("reviewed rematch releases a wrong quantity and preserves independent warnings", async () => {
  const f = fixture(); f.data.sales[0].optionName = "11개";
  const warning = { errorCode: "INDEPENDENT_WARNING", severity: "WARNING", columnName: "quantity", message: "preserve" };
  f.data.sales[0].validationErrors = [warning]; f.data.sales[0].validationStatus = "WARNING";
  const preview = await f.service.previewMappings(range);
  assert.equal(preview.summary.lostCount, 1);
  const result = await f.service.rematch(range, undefined, preview.previewToken!);
  assert.equal(result.updatedRowCount, 1); assert.equal(f.data.sales[0].coupangProductId, null);
  assert.equal(f.data.sales[0].validationErrors[0].errorCode, "INDEPENDENT_WARNING");
  assert.equal(f.data.sales[0].validationErrors[1].errorCode, "NO_MATCH");
});
test("draft preview has no apply token and does not mutate saved rules", async () => {
  const f = fixture();
  const preview = await f.service.previewMappings(range, { ruleId: "r", rule: { includeKeywords: ["베놈", "2개"] } });
  assert.equal(preview.previewToken, null); assert.equal(preview.summary.lostCount, 1);
  assert.deepEqual(f.data.rules[0].includeKeywords, ["베놈", "1개"]); assert.equal(f.calls.length, 0);
});
test("impossible keyword combinations and backwards periods are rejected", async () => {
  const f = fixture();
  await assert.rejects(f.service.previewMappings(range, { ruleId: "r", rule: { excludeKeywords: ["베놈"] } }), /필수 포함 키워드/);
  await assert.rejects(f.service.previewMappings(range, { ruleId: "r", rule: { validTo: "2026-09-01" } }), /종료일/);
});
test("server filters before pagination so issues beyond the former 500-row ceiling are reachable", async () => {
  const f = fixture();
  f.data.sales = Array.from({ length: 601 }, (_, index) => ({ ...f.data.sales[0], id: String(index), rowNumber: index,
    coupangProductId: null as any, validationStatus: "UNMATCHED", validationErrors: [{ errorCode: index === 600 ? "AMBIGUOUS_MATCH" : "NO_MATCH" }] }));
  const filtered = await f.service.mappingIssues({ ...range, issueType: "AMBIGUOUS", take: "100" });
  assert.equal(filtered.summary.totalCount, 601); assert.equal(filtered.filteredCount, 1); assert.equal(filtered.rows[0].rowNumber, 600);
  const last = await f.service.mappingIssues({ ...range, take: "100", offset: 600 });
  assert.equal(last.rows.length, 1); assert.equal(last.hasMore, false);
});
