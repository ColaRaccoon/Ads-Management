// Stage-06 integration over previously approved pseudonymized captures. No DB or provider calls.
import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { PLATFORMS, type Platform, type SourceCoverage } from "../apps/api/src/unified-performance/types";
import { ExactDecimal as D } from "../apps/api/src/unified-performance/domain/decimal";
import { compareTotals, reportBuckets, summarizeReport } from "../apps/api/src/unified-performance/domain/report-calculation";
import type { PublishedReportFact } from "../apps/api/src/unified-performance/report-contract";
import type { CompactReplayPartition, ReplayReconciliation } from "./unified-report-replay-capture";

const research = resolve("docs/product-performance/research"), to = "2026-10-26", outputPath = resolve(process.argv[2] ?? join(research, "06-live-replay-20261028.json"));
const temporary = mkdtempSync(join(tmpdir(), "unified-report-stage06-")), compactPath = join(temporary, "compact.jsonl");
const beforeEvidence = ["03-live-ads-replay-20261028.json", "03-live-cafe24-replay-20261028.json", "04-live-replay-20261028.json", "05-live-replay-20261028.json"]
  .map(name => ({ name, digest: createHash("sha256").update(readFileSync(join(research, name))).digest("hex") }));
const sumKnown = (values: readonly (string | null)[]) => {
  const known = values.filter((value): value is string => value !== null);
  return known.length ? known.reduce((total, value) => total.plus(value), new D(0)).toFixed(6) : null;
};
try {
  const replays = [
    { script: "unified-storefront-live-ads-replay.ts", input: join(research, "03-live-ads-result-20261028.json.gz") },
    { script: "unified-storefront-live-cafe24-replay.ts", input: join(research, "03-live-cafe24-result-20261028.json.gz") },
    { script: "unified-coupang-live-replay.ts", input: null }, { script: "unified-naver-live-replay.ts", input: null }
  ];
  for (const [index, replay] of replays.entries()) {
    const evidence = join(temporary, `${index}-source-replay.json`), args = ["--import", "tsx", resolve("scripts", replay.script), ...(replay.input ? [replay.input, evidence] : [])];
    execFileSync(process.execPath, args, { cwd: process.cwd(), windowsHide: true, stdio: "pipe", maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve("apps/api/tsconfig.json"), UNIFIED_PERFORMANCE_ENABLED: "true",
        UNIFIED_REPORT_REPLAY_OUTPUT: compactPath, UNIFIED_REPLAY_EVIDENCE_OUTPUT: evidence } });
    assert(existsSync(evidence), `${replay.script} source checks completed`);
  }
  for (const original of beforeEvidence) assert.equal(createHash("sha256").update(readFileSync(join(research, original.name))).digest("hex"), original.digest,
    `Previous stage evidence changed: ${original.name}`);
  const compactText = readFileSync(compactPath, "utf8"), partitions = compactText.trim().split("\n").map(line => JSON.parse(line) as CompactReplayPartition);
  assert.equal(new Set(partitions.map(row => JSON.stringify([row.platform, row.scopeKey, row.date]))).size, partitions.length, "one platform/account/day partition");
  assert.equal(new Set(partitions.map(row => row.platform)).size, 5);
  const allFacts: PublishedReportFact[] = partitions.flatMap(partition => partition.facts.map(fact => ({ ...fact, platform: partition.platform, scopeKey: partition.scopeKey, date: partition.date })));
  const allCoverage = partitions.flatMap(partition => partition.coverage);
  const scopes = [...new Set(partitions.map(row => JSON.stringify([row.platform, row.scopeKey])))].map(value => JSON.parse(value) as [Platform, string]);
  const days = (from: string, until: string) => Array.from({ length: Math.round((Date.parse(until) - Date.parse(from)) / 86400000) + 1 }, (_, offset) => new Date(Date.parse(from) + offset * 86400000).toISOString().slice(0, 10));
  const coverageFor = (from: string, until = to): SourceCoverage[] => {
    const result = allCoverage.filter(row => row.date >= from && row.date <= until);
    // Missing observations prove neither collection nor zero. Use only components actually produced by that source adapter.
    for (const [platform, scopeKey] of scopes) {
      const components = [...new Set(allCoverage.filter(row => row.platform === platform && row.scopeKey === scopeKey).map(row => row.component))];
      for (const date of days(from, until)) for (const component of components) if (!result.some(row => row.platform === platform && row.scopeKey === scopeKey && row.date === date && row.component === component)) {
        const template = allCoverage.find(row => row.platform === platform && row.scopeKey === scopeKey && row.component === component)!;
        result.push({ ...template, date, collectionState: "NOT_COLLECTED", rowsPresent: 0, zeroConfirmed: false, mappedRows: 0, unmappedRows: 0,
          unmatchedAmount: null, unallocatedAmount: null, sourceVersion: null, sourceAsOf: null, collectedAt: null, calculatedAt: null, lastSuccessAt: null,
          sourceFingerprint: null, quality: { ...template.quality, issues: ["CAPTURE_DATE_NOT_OBSERVED"] } });
      }
    }
    return result;
  };
  const measureTotal = (records: CompactReplayPartition[], measure: string) => sumKnown(records.flatMap(row => row.reconciliation.filter(control => control.measure === measure).map(control => control.sourceKnown)));
  const compareKnown = (actual: string | null, expected: string | null, message: string) => assert.equal(actual, expected, message);
  const periods = [1, 7, 30].map(dayCount => {
    const from = new Date(Date.parse(to) - (dayCount - 1) * 86400000).toISOString().slice(0, 10), records = partitions.filter(row => row.date >= from && row.date <= to),
      facts = allFacts.filter(row => row.date >= from && row.date <= to), coverage = coverageFor(from),
      previousTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10), previousFrom = new Date(Date.parse(from) - dayCount * 86400000).toISOString().slice(0, 10),
      previousRecords = partitions.filter(row => row.date >= previousFrom && row.date <= previousTo),
      previousFacts = allFacts.filter(row => row.date >= previousFrom && row.date <= previousTo), previousCoverage = coverageFor(previousFrom, previousTo);
    const checks = Array.from({ length: 32 }, (_, mask) => {
      const platforms = PLATFORMS.filter((_, index) => (mask & (1 << index)) !== 0), selected = records.filter(row => platforms.includes(row.platform)),
        report = summarizeReport(facts, coverage, { platforms });
      const hasSale = platforms.some(platform => ["CAFE24", "NAVER", "COUPANG"].includes(platform)), hasAd = platforms.some(platform => platform !== "CAFE24");
      compareKnown(report.knownTotals.revenue, hasSale ? measureTotal(selected, "OPERATING_REVENUE") : null, `${dayCount}/${mask} selected sales`);
      compareKnown(report.knownTotals.adSpend, hasAd ? measureTotal(selected, "AD_SPEND_KRW") : null, `${dayCount}/${mask} selected ads`);
      const base = measureTotal(selected, "PROFIT_BEFORE_ADS"), selectedAds = measureTotal(selected, "AD_SPEND_KRW"),
        expense = sumKnown([measureTotal(selected, "SHIPPING_COST"), measureTotal(selected, "FAKE_PURCHASE"), measureTotal(selected, "OTHER")]),
        income = measureTotal(selected, "SHIPPING_INCOME"), expectedProfit = !hasSale || base === null ? null : new D(base).minus(selectedAds ?? "0").minus(expense ?? "0").plus(income ?? "0").toFixed(6);
      compareKnown(report.knownTotals.estimatedProfit, expectedProfit, `${dayCount}/${mask} selected profit`);
      const balance = report.scopeBalances, applicableCommon = coverage.some(row => platforms.includes(row.platform) && row.component === "COMMON_EXPENSE" && row.participation === "INCLUDED"),
        applicableAd = coverage.some(row => platforms.includes(row.platform) && row.component === "AD_SPEND" && row.participation === "INCLUDED");
      const profitBalanceChecked = report.productProfitSubtotal !== null && report.knownTotals.estimatedProfit !== null && balance.unclassifiedProfitBeforeAds !== null &&
        (!applicableAd || balance.unallocatedAdSpend !== null) && (!applicableCommon || balance.unallocatedExpense !== null && balance.unallocatedShippingIncome !== null);
      if (profitBalanceChecked) assert.equal(new D(report.productProfitSubtotal!).plus(balance.unclassifiedProfitBeforeAds!)
        .minus(balance.unallocatedAdSpend ?? "0").minus(balance.unallocatedExpense ?? "0").plus(balance.unallocatedShippingIncome ?? "0").toFixed(6),
      report.knownTotals.estimatedProfit, `${dayCount}/${mask} product subtotal plus scope balance reconciliation`);
      for (const medium of report.byMedium) if (medium.adSpend !== null && report.knownTotals.adSpend !== null && new D(report.knownTotals.adSpend).gt(0))
        assert.equal(medium.share, new D(medium.adSpend).div(report.knownTotals.adSpend).mul(100).toFixed(10), `${dayCount}/${mask} selected share denominator`);
      const sameSelectionPrevious = summarizeReport(previousFacts, previousCoverage, { platforms }), priorSelected = previousRecords.filter(row => platforms.includes(row.platform));
      compareKnown(sameSelectionPrevious.knownTotals.revenue, hasSale ? measureTotal(priorSelected, "OPERATING_REVENUE") : null, `${dayCount}/${mask} previous selected sales`);
      compareKnown(sameSelectionPrevious.knownTotals.adSpend, hasAd ? measureTotal(priorSelected, "AD_SPEND_KRW") : null, `${dayCount}/${mask} previous selected ads`);
      const comparison = compareTotals(report.knownTotals, sameSelectionPrevious.knownTotals, dayCount, dayCount);
      for (const [metric, change] of Object.entries(comparison)) assert.equal(change.change, change.current === null || change.previous === null ? null :
        new D(change.current).minus(change.previous).toFixed(metric === "mer" ? 10 : 6), `${dayCount}/${mask} real previous-period delta`);
      if (dayCount > 1 && platforms.includes("NAVER")) assert.equal(report.completeTotals.revenue, null, "unobserved Naver days remain incomplete");
      for (const grain of ["week", "month"] as const) {
        const buckets = reportBuckets(from, to, grain).map(bucket => summarizeReport(facts.filter(row => row.date >= bucket.bucketFrom && row.date <= bucket.bucketTo),
          coverage.filter(row => row.date >= bucket.bucketFrom && row.date <= bucket.bucketTo), { platforms }));
        assert.equal(sumKnown(buckets.map(bucket => bucket.knownTotals.revenue)), report.knownTotals.revenue, `${dayCount}/${mask}/${grain} revenue preservation`);
        assert.equal(sumKnown(buckets.map(bucket => bucket.knownTotals.adSpend)), report.knownTotals.adSpend, `${dayCount}/${mask}/${grain} ad preservation`);
      }
      return { platforms, knownTotals: report.knownTotals, completeTotals: report.completeTotals, previousKnownTotals: sameSelectionPrevious.knownTotals,
        revenueChange: comparison.revenue.change, adSpendChange: comparison.adSpend.change,
        scopeBalances: report.scopeBalances, profitBalanceChecked,
        unallocatedAdSpend: report.scopeBalances.unallocatedAdSpend, unallocatedExpense: report.scopeBalances.unallocatedExpense };
    });
    const noNaver = PLATFORMS.filter(platform => platform !== "NAVER"), normal = summarizeReport(facts, coverage, { platforms: noNaver }),
      failed = summarizeReport(facts, coverage.map(row => row.platform !== "NAVER" ? row : { ...row, collectionState: "NOT_COLLECTED", quality: { ...row.quality, issues: ["NAVER_READ_FAILED"] } }), { platforms: noNaver });
    assert.deepEqual(failed, normal, "excluded Naver read failure isolation");
    const reconciliation = [...new Set(records.flatMap(row => row.reconciliation.map(control => control.measure)))].map(measure => {
      const controls: ReplayReconciliation[] = records.flatMap(row => row.reconciliation.filter(control => control.measure === measure));
      const sourceKnown = sumKnown(controls.map(row => row.sourceKnown)), reportKnown = sumKnown(controls.map(row => row.reportKnown)),
        assigned = sumKnown(controls.map(row => row.assignedKnown)), unassigned = sumKnown(controls.map(row => row.unassignedKnown));
      assert.equal(sourceKnown, reportKnown, `${dayCount}/${measure} aggregate compact conservation`);
      if (reportKnown !== null) assert.equal(new D(reportKnown).minus(assigned ?? "0").minus(unassigned ?? "0").toFixed(6), "0.000000");
      return { measure, sourceKnown, reportKnown, assigned, unassigned, unknownSourceRows: controls.reduce((total, row) => total + row.unknownSourceRows, 0), difference: sourceKnown === null ? null : "0.000000" };
    });
    return { days: dayCount, from, to, previousFrom, previousTo, actualPartitionCount: records.length, actualPreviousPartitionCount: previousRecords.length,
      synthesizedMissingComponents: coverage.filter(row => row.quality.issues.includes("CAPTURE_DATE_NOT_OBSERVED")).length,
      actualNaverDays: new Set(records.filter(row => row.platform === "NAVER").map(row => row.date)).size, selectionChecks: 32, reconciliation, checks };
  });
  const evidence = { status: "PASS_INTEGRATED_CAPTURE_REPLAY", stage: 6, sourceObservationDate: "2026-10-28", databaseAccess: false, sourceWrites: 0, providerCalls: 0,
    previousStageEvidenceUnchanged: true, partitionCount: partitions.length, compactFacts: allFacts.length, compactCaptureSha256: createHash("sha256").update(compactText).digest("hex"),
    platforms: PLATFORMS.map(platform => ({ platform, scopes: scopes.filter(([value]) => value === platform).length,
      observedDays: new Set(partitions.filter(row => row.platform === platform).map(row => row.date)).size,
      compactFacts: allFacts.filter(row => row.platform === platform).length })), periods,
    limitations: ["This verifies integrated stage-06 transfer, aggregation, selection, ratios and bucket conservation over already accepted source captures.",
      "Source adapter parity replays execute separately; they do not alone establish integrated correctness.",
      "Naver input is observed only on 2026-10-26. Seven/thirty-day complete totals remain null where the unobserved dates are selected.",
      "Captured read-only statements were independent; a remote atomic snapshot and runtime reader grants are not claimed.",
      "Capture-missing dates and non-active historical account dates are not treated as confirmed zero; collection horizon policy remains explicit.",
      "Known partial numbers retain unknown cost/revenue rows; no settlement accuracy claim is made for accepted Naver estimates."] };
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ status: evidence.status, partitionCount: evidence.partitionCount, compactFacts: evidence.compactFacts, platforms: evidence.platforms,
    periods: periods.map(({ checks, ...period }) => period), outputPath }, null, 2));
} finally {
  const tempRoot = resolve(tmpdir()), cleanup = resolve(temporary);
  assert(cleanup.startsWith(tempRoot + "\\") || cleanup.startsWith(tempRoot + "/"));
  assert(temporary.includes("unified-report-stage06-"));
  rmSync(cleanup, { recursive: true, force: true });
}
