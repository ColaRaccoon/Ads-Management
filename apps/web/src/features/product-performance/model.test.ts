import test, { after } from "node:test";
import assert from "node:assert/strict";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { ApiError } from "@/lib/api";
import { assertResponse, changeFilters, comparisonReason, dashboardKey, difference, effectiveFilters, filterParams, loadDashboard, loadDiagnostics, selectionOptionsKey, money, parseFilters, percent, percentagePoints, ratioPercent, responseMatches, validateFilters, type Reader } from "./model";
import { testData, testEnvelope, testFilters } from "./test-fixture";
import type { Envelope } from "./types";
after(() => (authCoordinator as unknown as { channel: BroadcastChannel | null }).channel?.close());

test("URL round-trip distinguishes omission/empty, normalizes platform/cache keys and preserves exact product names", () => {
  const f = testFilters({ platforms: ["NAVER", "META", "NAVER"], scopeKeys: [] });
  assert.deepEqual(f.platforms, ["META", "NAVER"]);
  assert.deepEqual(parseFilters(filterParams(f, true)), f);
  assert.deepEqual(parseFilters(new URLSearchParams("platforms=[]")).platforms, []);
  assert.equal(parseFilters(new URLSearchParams()).platforms.length, 5);
  assert.notDeepEqual(dashboardKey("viewer", f), dashboardKey("other-user", f));
  assert.notDeepEqual(dashboardKey("viewer", f), dashboardKey("viewer", { ...f, platforms: ["META"] }));
  assert.notDeepEqual(dashboardKey("viewer", f), dashboardKey("viewer", { ...f, scopeKeys: undefined }));
  for (const q of ['platforms=["UNKNOWN"]', 'scopeKeys=[4]', 'scopeMemory={"x":"UNKNOWN"}', 'grain=quarter']) assert.throws(() => parseFilters(new URLSearchParams(q)));
});
test("same-day-count, previous weekday and direct comparison handle leap days and range limits", () => {
  const previous = effectiveFilters(testFilters({ from: "2024-03-01", to: "2024-03-02" }));
  assert.equal(previous.compareFrom, "2024-02-28"); assert.equal(previous.compareTo, "2024-02-29");
  const week = effectiveFilters({ ...previous, compareMode: "week" });
  assert.equal(week.compareFrom, "2024-02-23"); assert.equal(week.compareTo, "2024-02-24");
  const direct = testFilters({ compareMode: "custom", compareFrom: "2023-01-01", compareTo: "2023-01-31" });
  assert.equal(direct.compareTo, "2023-01-31");
  assert.equal(validateFilters(direct), null);
  assert.ok(validateFilters({ ...direct, from: "2026-02-30" }));
  assert.ok(validateFilters({ ...direct, from: "2024-01-01", to: "2025-01-01" }));
  assert.ok(validateFilters({ ...direct, from: "" }));
});
test("explicit account selection survives excluded platform off/on and URL reload without sending excluded accounts", () => {
  const scopes = [{ platform: "NAVER" as const, scopeKey: "store-n", label: "네이버" }, { platform: "CAFE24" as const, scopeKey: "store-c", label: "자사몰" }];
  const original = testFilters({ platforms: ["NAVER", "CAFE24"], scopeKeys: ["store-n", "store-c"] });
  const excluded = changeFilters(original, { ...original, platforms: ["CAFE24"] }, scopes);
  assert.deepEqual(excluded.scopeKeys, ["store-c"]);
  assert.ok(!filterParams(excluded).toString().includes("scopeMemory"));
  assert.deepEqual(JSON.parse(filterParams(excluded).get("scopeKeys")!), ["store-c"]);
  const reloaded = parseFilters(filterParams(excluded, true));
  const restored = changeFilters(reloaded, { ...reloaded, platforms: ["NAVER", "CAFE24"] }, scopes.filter(s => s.platform === "CAFE24"));
  assert.deepEqual(restored.scopeKeys, ["store-c", "store-n"]);
  const cleared = changeFilters(restored, { ...restored, scopeKeys: [] }, scopes);
  assert.deepEqual(cleared.scopeKeys, []); assert.deepEqual(cleared.scopeMemory, {});
  assert.equal(changeFilters(restored, { ...restored, scopeKeys: undefined }, scopes).scopeMemory, undefined);
});
test("exact decimal formatting and ratios preserve large amounts, percentage units and half-up rounding", () => {
  assert.equal(money("9007199254740993.000001"), "9,007,199,254,740,993.000001 원");
  assert.equal(difference("9007199254740993.000001", "9007199254740993.000000"), "0.0000010000");
  assert.equal(ratioPercent("2", "3"), "66.6666666667");
  assert.equal(ratioPercent("-2", "3"), "-66.6666666667");
  assert.equal(ratioPercent("1", "0"), null);
  assert.equal(percent("45.1250000000"), "45.13%"); assert.equal(percentagePoints("7.5"), "7.5 %p");
  const base = testEnvelope().comparison.known.estimatedProfit;
  assert.equal(comparisonReason({ ...base, current: "1", previous: "-2", reason: "NON_POSITIVE_PROFIT_BASE" }), "흑자 전환");
  assert.equal(comparisonReason({ ...base, current: "-1", previous: "2", reason: "NON_POSITIVE_PROFIT_BASE" }), "적자 전환");
});
test("a shared legacy scope remains selected when either Meta or Cafe24 is included", () => {
  const scopes = [{ platform: "META" as const, scopeKey: "LEGACY_UNBOUND", label: "Meta CSV" }, { platform: "CAFE24" as const, scopeKey: "LEGACY_UNBOUND", label: "Cafe24 CSV" }];
  const original = testFilters({ platforms: ["META", "CAFE24"], scopeKeys: ["LEGACY_UNBOUND"] });
  const onlyMeta = changeFilters(original, { ...original, platforms: ["META"] }, scopes);
  assert.deepEqual(onlyMeta.scopeKeys, ["LEGACY_UNBOUND"]);
  const restored = parseFilters(filterParams(onlyMeta, true));
  const onlyCafe = changeFilters(restored, { ...restored, platforms: ["CAFE24"] }, scopes.slice(0, 1));
  assert.deepEqual(onlyCafe.scopeKeys, ["LEGACY_UNBOUND"]);
});
test("response validation refuses stale selection, omitted explicit accounts and mixed endpoint snapshots", () => {
  const f = testFilters({ scopeKeys: ["a", "b"] }), e = testEnvelope(f);
  assert.ok(responseMatches(e, f));
  assert.equal(responseMatches({ ...e, selection: { ...e.selection, scopeKeys: ["a"] } }, f), false);
  assert.equal(responseMatches(e, { ...f, platforms: ["META"] }), false);
  assert.throws(() => assertResponse({ ...e, snapshotHash: "new" }, f, e), ApiError);
});
test("one dashboard request includes every daily bucket and never eagerly fetches product rows or diagnostics", async () => {
  const f = testFilters({ from: "2024-01-01", to: "2024-12-31" }), data = testData(f), seen: string[] = [];
  data.summary.items = []; data.summary.total = 0;
  data.timeseries.items = Array.from({ length: 366 }, () => data.timeseries.items[0]); data.timeseries.total = 366;
  const result = await loadDashboard(f, async <T,>(path: string) => { seen.push(path); return structuredClone(data) as T; });
  assert.equal(seen.length, 1); assert.match(seen[0], /^\/unified-performance\/dashboard\?/);
  assert.equal(result.timeseries.items.length, 366); assert.equal(result.diagnostics.items.length, 0);
  assert.equal(result.summary.total, 0);
});

test("single dashboard validates coherent snapshot, retries once, and rejects a truncated series", async () => {
  const f = testFilters(), data = testData(f); let requests = 0;
  const result = await loadDashboard(f, async <T,>() => {
    const next = structuredClone(data); requests++;
    if (requests === 1) next.timeseries.snapshotHash = "different";
    return next as T;
  });
  assert.equal(requests, 2); assert.equal(result.summary.snapshotHash, data.summary.snapshotHash);
  await assert.rejects(loadDashboard(f, async <T,>() => ({ ...data, timeseries: { ...data.timeseries, total: 366 } }) as T), /완전하지 않습니다/);
});

test("diagnostics are a separate requested operation bound to displayed scope and snapshot", async () => {
  const f = testFilters(), data = testData(f), seen: string[] = [];
  const result = await loadDiagnostics(f, data.summary, "page2", async <T,>(path: string) => { seen.push(path); return { ...data.diagnostics, nextCursor: "page3" } as T; });
  assert.equal(seen.length, 1); assert.match(seen[0], /diagnostics\?/); assert.match(seen[0], /cursor=page2/);
  assert.equal(result.nextCursor, "page3");
  await assert.rejects(loadDiagnostics(f, data.summary, undefined, async <T,>() => ({ ...data.diagnostics, snapshotHash: "new" }) as T), ApiError);
  assert.equal(data.summary.snapshotHash, "snapshot");
});

test("selection options cache metadata across products without sharing users, platforms or date ranges", () => {
  const f = testFilters();
  assert.deepEqual(selectionOptionsKey("u", f), selectionOptionsKey("u", { ...f, productName: "other", scopeKeys: ["account"] }));
  assert.notDeepEqual(selectionOptionsKey("u", f), selectionOptionsKey("other-user", f));
  assert.notDeepEqual(selectionOptionsKey("u", f), selectionOptionsKey("u", { ...f, platforms: ["META"] }));
  assert.notDeepEqual(selectionOptionsKey("u", f), selectionOptionsKey("u", { ...f, to: "2026-10-27" }));
});

test("rapid toggles forward cancellation and never finish into a new selection", async () => {
  const f = testFilters(), controller = new AbortController(); let forwarded: AbortSignal | undefined;
  let release!: (value: ReturnType<typeof testData>) => void;
  const pending = new Promise<ReturnType<typeof testData>>(resolve => { release = resolve; });
  const read: Reader = async <T,>(_path: string, signal?: AbortSignal) => { forwarded = signal; return await pending as T; };
  const old = loadDashboard(f, read, controller.signal); assert.equal(forwarded, controller.signal);
  controller.abort(); release(testData(f));
  await assert.rejects(old, error => error instanceof Error && error.name === "AbortError");
  const changed = testFilters({ platforms: ["NAVER"] }), data = testData(changed);
  const fresh = await loadDashboard(changed, async <T,>() => structuredClone(data) as T);
  assert.deepEqual(fresh.summary.selectedPlatforms, ["NAVER"]);
});
