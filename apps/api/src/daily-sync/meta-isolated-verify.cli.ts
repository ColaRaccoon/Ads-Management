import { readFile } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { MetaAdDailyCsvParser } from "../domain/meta-ad-daily-csv";
import { MetaAdsClient, MetaAdProbeRow } from "./meta-ads.client";
import { configuredMetaSettings } from "./meta-sync-runner.service";
import { SAFE_SYNC_CODES } from "./sync-contract";

/** Temporary ads_read verification. It has no database, upload, or publish path. */
async function main() {
  const accountId = process.env.META_VERIFICATION_ACCOUNT_ID;
  const day = process.env.META_VERIFICATION_DAY;
  if (!accountId || !/^\d{1,30}$/.test(accountId) || !day ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) || !process.env.DAILY_SYNC_META_ACCESS_TOKEN)
    throw new Error("VERIFICATION_INPUT_REQUIRED");
  const snapshot = await new MetaAdsClient().probeDay({ accountId, day,
    deadlineAt: Date.now() + 3 * 60_000, settings: configuredMetaSettings() });
  const api = { rowCount: snapshot.ads.length, pageCount: snapshot.pageCount,
    spendUsd: snapshot.accountSpendUsd, impressions: snapshot.accountImpressions,
    inlineLinkClicks: snapshot.accountInlineLinkClicks,
    shopClicksFieldPresent: snapshot.shopClicksFieldPresent,
    actionTypes: snapshot.actionTypes, attributionSettings: snapshot.attributionSettings,
    actionTotals: snapshot.actionTotals };
  let csv: ReturnType<typeof compareCsv> | null = null;
  if (process.env.META_VERIFICATION_CSV) {
    const bytes = await readFile(process.env.META_VERIFICATION_CSV);
    if (bytes.length > 20 * 1024 * 1024) throw new Error("VERIFICATION_INPUT_REQUIRED");
    csv = compareCsv(bytes, snapshot.ads, day);
  }
  process.stdout.write(JSON.stringify({ graphVersion: "v26.0", accountId,
    day, currencyCode: snapshot.currencyCode, timeZone: snapshot.timeZone,
    actionReportTime: process.env.DAILY_SYNC_META_ACTION_REPORT_TIME,
    attributionWindows: process.env.DAILY_SYNC_META_ATTRIBUTION_WINDOWS,
    api, csv, reconciliationScope: "AD_ID_SPEND_IMPRESSIONS_INLINE_LINK_CLICKS",
    unresolved: ["CSV_ACCOUNT_BINDING", "CSV_ATTRIBUTION_SETTING_ABSENT",
      "MIXED_RESULT_INDICATORS", "ADSET_AND_METADATA_NOT_PROBED",
      "SHOP_CLICKS_MISSING_IF_FALSE", "PERSISTENT_AUTH_AND_TIER"] }) + "\n");
}

export function compareCsv(bytes: Buffer, apiRows: MetaAdProbeRow[], day: string) {
  const parser = new MetaAdDailyCsvParser();
  const file = parser.parseBuffer(bytes);
  const parsed = file.rows.map((row) => parser.parseRow(row));
  if (parsed.some((row) => row.issues.length || !row.parsedRow))
    throw new Error("CSV_VALIDATION_FAILED");
  const rows = parsed.map((row) => row.parsedRow!);
  if (rows.some((row) => row.metricDate.toISOString().slice(0, 10) !== day ||
      row.dateEnd.toISOString().slice(0, 10) !== day)) throw new Error("CSV_SCOPE_MISMATCH");
  const csvById = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (!row.metaAdId || csvById.has(row.metaAdId)) throw new Error("CSV_ID_REQUIRED");
    csvById.set(row.metaAdId, row);
  }
  const apiById = new Map(apiRows.map((row) => [row.adId, row]));
  const csvSpend = rows.reduce((sum, row) => sum.plus(row.spendUsd), new Prisma.Decimal(0));
  const apiSpend = apiRows.reduce((sum, row) => sum.plus(row.spendUsd), new Prisma.Decimal(0));
  const csvImpressions = rows.reduce((sum, row) => sum + BigInt(row.impressions), 0n);
  const apiImpressions = apiRows.reduce((sum, row) => sum + BigInt(row.impressions), 0n);
  const csvLinkClicks = rows.reduce((sum, row) => sum + row.linkClicks, 0);
  const apiLinkClicks = apiRows.reduce((sum, row) => sum + row.inlineLinkClicks, 0);
  const matchedRows = rows.filter((row) => apiById.has(row.metaAdId!));
  const differing = matchedRows.filter((row) => {
    const api = apiById.get(row.metaAdId!)!;
    return !new Prisma.Decimal(row.spendUsd).eq(api.spendUsd) ||
      BigInt(row.impressions) !== BigInt(api.impressions) || row.linkClicks !== api.inlineLinkClicks;
  });
  const csvOnlyZeroIds = rows.filter((row) => row.spendUsd === 0 && !apiById.has(row.metaAdId!));
  const csvOnlyWithActivity = csvOnlyZeroIds.filter((row) => row.impressions > 0 || row.linkClicks > 0 ||
    row.clicksAll > 0 || row.landingPageViews > 0 || row.resultCount > 0 ||
    row.purchaseCount > 0 || (row.addToCartCount ?? 0) > 0 ||
    [row.videoPlay3sCount, row.videoPlay25Count, row.videoPlay50Count,
      row.videoPlay75Count, row.videoPlay100Count].some((value) => (value ?? 0) > 0));
  return { rowCount: rows.length, zeroSpendRows: rows.filter((row) => row.spendUsd === 0).length,
    matchedIds: matchedRows.length, matchedNonzeroIds: matchedRows.filter((row) => row.spendUsd > 0).length,
    csvOnlyZeroIds: csvOnlyZeroIds.length,
    csvOnlyZeroWithActivityIds: csvOnlyWithActivity.length,
    csvOnlyZeroWithoutMeasuredActivityIds: csvOnlyZeroIds.length - csvOnlyWithActivity.length,
    zeroSpendApiOmission: "ONLY_NO_MEASURED_ACTIVITY_EXCLUDED_FROM_BASIC_METRIC_MISMATCH",
    apiOnlyIds: apiRows.filter((row) => !csvById.has(row.adId)).length,
    csvOnlyNonzeroIds: rows.filter((row) => row.spendUsd > 0 && !apiById.has(row.metaAdId!)).length,
    differingMatchedIds: differing.length,
    maxMatchedSpendDifferenceUsd: differing.reduce((max, row) => {
      const delta = new Prisma.Decimal(apiById.get(row.metaAdId!)!.spendUsd).minus(row.spendUsd).abs();
      return Prisma.Decimal.max(max, delta);
    }, new Prisma.Decimal(0)).toFixed(4),
    maxMatchedImpressionsDifference: differing.reduce((max, row) => {
      const delta = BigInt(apiById.get(row.metaAdId!)!.impressions) - BigInt(row.impressions);
      const abs = delta < 0n ? -delta : delta;
      return abs > max ? abs : max;
    }, 0n).toString(),
    maxMatchedLinkClicksDifference: differing.reduce((max, row) =>
      Math.max(max, Math.abs(apiById.get(row.metaAdId!)!.inlineLinkClicks - row.linkClicks)), 0),
    spendUsd: csvSpend.toFixed(4), spendDifferenceUsd: apiSpend.minus(csvSpend).toFixed(4),
    impressions: csvImpressions.toString(), impressionsDifference: (apiImpressions - csvImpressions).toString(),
    inlineLinkClicks: csvLinkClicks, inlineLinkClicksDifference: apiLinkClicks - csvLinkClicks,
    actionTotals: { purchase: rows.reduce((sum, row) => sum + row.purchaseCount, 0),
      addToCart: rows.every((row) => row.addToCartCount !== null)
        ? rows.reduce((sum, row) => sum + row.addToCartCount!, 0) : null,
      video3s: sumOptional(rows.map((row) => row.videoPlay3sCount)),
      video25: sumOptional(rows.map((row) => row.videoPlay25Count)),
      video50: sumOptional(rows.map((row) => row.videoPlay50Count)),
      video75: sumOptional(rows.map((row) => row.videoPlay75Count)),
      video100: sumOptional(rows.map((row) => row.videoPlay100Count)) },
    resultIndicatorKinds: new Set(rows.map((row) => row.resultIndicator ?? "NONE")).size,
    attributionColumnPresent: file.headers.includes("기여 설정"),
    actionComparison: "OBSERVED_TOTALS_ONLY_ATTRIBUTION_UNVERIFIED" };
}

function sumOptional(values: Array<number | null>) {
  return values.every((value) => value !== null) ? values.reduce<number>((sum, value) => sum + value!, 0) : null;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const raw = error && typeof error === "object" && "safeCode" in error ? error.safeCode : null;
    const code = typeof raw === "string" && SAFE_SYNC_CODES.has(raw) ? raw :
      error instanceof Error && ["VERIFICATION_INPUT_REQUIRED", "CSV_VALIDATION_FAILED",
        "CSV_SCOPE_MISMATCH", "CSV_ID_REQUIRED"].includes(error.message) ? error.message : "VERIFICATION_FAILED";
    process.stdout.write(JSON.stringify({ code }) + "\n");
    process.exitCode = 1;
  });
}
