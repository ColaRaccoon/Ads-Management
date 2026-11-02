import test, { after } from "node:test";
import assert from "node:assert/strict";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { loadDailyProducts } from "./daily-products-data";
import type { DailyProductsResponse } from "./daily-products-model";
import type { Reader } from "./model";
import { testData, testEnvelope, testFilters } from "./test-fixture";

after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());

const filters = testFilters({ from: "2026-10-31", to: "2026-11-01", compareMode: "custom", compareFrom: "2026-10-31", compareTo: "2026-10-31", productName: "선택 제품" });
function fixture(): DailyProductsResponse {
  const data = testData(filters), metric = testEnvelope(filters);
  data.timeseries.items = [filters.from, filters.to].map(date => ({ ...metric, date, bucketFrom: date, bucketTo: date, partial: false }));
  data.timeseries.total = 2;
  return { ...data, reportDate: filters.to, previousDate: filters.from, totalProducts: 2, nextCursor: null,
    products: ["선택 제품", "다른 제품"].map((productName, i) => ({ productName, productKey: `p${i}`, active: i === 0, historical: i !== 0, current: metric, previous: metric })),
    allProducts: { current: metric, previous: metric } };
}
function reader(value: DailyProductsResponse, calls: string[]): Reader {
  return async <T>(path: string) => { calls.push(path); return structuredClone(value) as T; };
}

test("one request supplies selected summary and every product for print and export", async () => {
  const calls: string[] = [];
  const result = await loadDailyProducts(filters, reader(fixture(), calls));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("/unified-performance/daily-products?"));
  assert.equal(new URLSearchParams(calls[0].split("?")[1]).get("productName"), "선택 제품");
  assert.equal(result.report.rows.length, 2);
  assert.deepEqual(new Set(result.report.rows.map(row => row.productName)), new Set(["선택 제품", "다른 제품"]));
  assert.equal(result.report.snapshotHash, result.summary.snapshotHash);
  assert.equal(result.report.previousDate, "2026-10-31");
});

test("incomplete, duplicate, paginated and wrong-day responses never become printable reports", async () => {
  const cases: Array<(value: DailyProductsResponse) => void> = [
    data => { data.totalProducts = 3; },
    data => { data.products[1].productKey = data.products[0].productKey; },
    data => { (data as unknown as { nextCursor: string }).nextCursor = "more"; },
    data => { data.previousDate = "2026-10-30"; },
    data => { data.timeseries.items[1] = data.timeseries.items[0]; },
    data => { data.timeseries.items[0].bucketTo = filters.to; },
  ];
  for (const mutate of cases) {
    const data = fixture(), calls: string[] = []; mutate(data);
    await assert.rejects(loadDailyProducts(filters, reader(data, calls)), /범위|발행/);
    assert.equal(calls.length, 2, "only one bounded retry");
  }
});

test("snapshot mismatch is retried once as a whole response, never stitched", async () => {
  let calls = 0;
  const read: Reader = async <T>() => {
    const data = fixture();
    if (++calls === 1) data.timeseries.snapshotHash = "different";
    else { data.summary.snapshotHash = "fresh"; data.timeseries.snapshotHash = "fresh"; }
    return data as T;
  };
  const data = await loadDailyProducts(filters, read);
  assert.equal(calls, 2); assert.equal(data.report.snapshotHash, "fresh");
});

test("aborted requests and invalid daily intervals do not fetch or export", async () => {
  const controller = new AbortController(), calls: string[] = [];
  controller.abort();
  await assert.rejects(loadDailyProducts(filters, reader(fixture(), calls), controller.signal), { name: "AbortError" });
  await assert.rejects(loadDailyProducts({ ...filters, from: "2026-10-01" }, reader(fixture(), calls)), /바로 전날/);
  assert.equal(calls.length, 0);
});

test("a confirmed empty catalog stays empty rather than fabricating a product", async () => {
  const data = fixture(); data.products = []; data.totalProducts = 0;
  const result = await loadDailyProducts(filters, reader(data, []));
  assert.equal(result.report.rows.length, 0);
});
