import test, { after } from "node:test";
import assert from "node:assert/strict";
import { authCoordinator } from "@/features/auth/auth-coordination";
import { ApiError } from "@/lib/api";
import { assertResponse, changeFilters, comparisonReason, dashboardKey, difference, effectiveFilters, filterParams, loadDashboard, money, parseFilters, percent, percentagePoints, ratioPercent, responseMatches, validateFilters, type Reader } from "./model";
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
test("loader fetches every timeseries page and retries an entire changed snapshot, keeping diagnostics cursor explicit", async () => {
  const f = testFilters(), seen: string[] = [], data = testData(f);
  const read: Reader = async <T,>(path: string) => {
    seen.push(path);
    const url = new URL(path, "http://fixture"), kind = url.pathname.split("/").at(-1)!;
    const result = structuredClone(data[kind as keyof typeof data]);
    if (kind === "timeseries") result.nextCursor = url.searchParams.has("cursor") ? null : "page2";
    if (kind === "diagnostics") result.nextCursor = "diagnostics-page2";
    if (seen.length <= 3 && kind === "diagnostics") result.snapshotHash = "new-publication";
    return result as T;
  };
  const result = await loadDashboard(f, read);
  assert.equal(seen.filter(p => p.includes("summary?")).length, 2);
  assert.equal(result.timeseries.items.length, 2); assert.equal(result.timeseries.nextCursor, null);
  assert.equal(result.diagnostics.nextCursor, "diagnostics-page2");
  for (const path of seen) assert.deepEqual(JSON.parse(new URL(path, "http://fixture").searchParams.get("platforms")!), f.platforms);
});
test("rapid toggles use isolated caches and a cancelled selection never finishes into the new selection", async () => {
  const f = testFilters(), controller = new AbortController();
  let release!: (value: Envelope) => void;
  const pending = new Promise<Envelope>(resolve => { release = resolve; });
  const read: Reader = async <T,>() => await pending as T;
  const old = loadDashboard(f, read, controller.signal);
  controller.abort(); release(testEnvelope(f));
  await assert.rejects(old, error => error instanceof Error && error.name === "AbortError");
  const changed = testFilters({ platforms: ["NAVER"] }), data = testData(changed);
  const fresh = await loadDashboard(changed, async <T,>(path: string) => structuredClone(data[path.split("?")[0].split("/").at(-1) as keyof typeof data]) as T);
  assert.deepEqual(fresh.summary.selectedPlatforms, ["NAVER"]);
});
