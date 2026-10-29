import type { Bucket, Metric } from "./types";

/** A chart coordinate is approximate; money displayed to people always uses the original string. */
export function chartNumber(value: string | null | undefined): number | null {
  if (value == null || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const integer = BigInt(whole);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  if ((integer === BigInt(Number.MAX_SAFE_INTEGER) || integer === -BigInt(Number.MAX_SAFE_INTEGER)) && /[1-9]/.test(fraction)) return null;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && Math.abs(coordinate) <= Number.MAX_SAFE_INTEGER ? coordinate : null;
}

export function completeCoordinate(bucket: Bucket, metric: Metric) {
  return chartNumber(bucket.completeTotals[metric]);
}

function micro(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
  return negative ? -result : result;
}

/** Only seven consecutive, numerically complete daily buckets form a moving average. */
export function movingAverages(buckets: Bucket[]): Array<string | null> {
  return buckets.map((bucket, index) => {
    if (index < 6) return null;
    const window = buckets.slice(index - 6, index + 1);
    if (window.some((row, offset) => row.completeTotals.adSpend === null || row.bucketFrom !== row.bucketTo ||
      Date.parse(`${row.date}T00:00:00Z`) !== Date.parse(`${bucket.date}T00:00:00Z`) - (6 - offset) * 86400000)) return null;
    const total = window.reduce((sum, row) => sum + micro(row.completeTotals.adSpend!), 0n);
    const negative = total < 0n;
    const absolute = negative ? -total : total;
    const average = absolute / 7n + (absolute % 7n >= 4n ? 1n : 0n);
    return `${negative && average !== 0n ? "-" : ""}${average / 1000000n}.${(average % 1000000n).toString().padStart(6, "0")}`;
  });
}

export function bucketLabel(bucket: Bucket) {
  return `${bucket.bucketFrom}${bucket.bucketTo !== bucket.bucketFrom ? ` ~ ${bucket.bucketTo}` : ""}${bucket.partial ? " · 부분기간" : ""}`;
}

export function compositionAvailable(bucket: Bucket) {
  const total = bucket.completeTotals.adSpend ?? bucket.knownTotals.adSpend;
  const known = bucket.byMedium.filter(row => row.adSpend !== null);
  return total !== null && chartNumber(total) !== null && chartNumber(total)! > 0 && known.length > 0 &&
    known.every(row => chartNumber(row.adSpend) !== null && chartNumber(row.adSpend)! >= 0 &&
      row.share !== null && chartNumber(row.share) !== null && chartNumber(row.share)! >= 0 && chartNumber(row.share)! <= 100) &&
    known.reduce((sum, row) => sum + micro(row.adSpend!), 0n) === micro(total);
}

export function chartRows(buckets: Bucket[], media: string[]) {
  const averages = movingAverages(buckets);
  return buckets.map((bucket, index) => {
    const row: Record<string, string | number | null> = { date: bucket.date,
      revenue: completeCoordinate(bucket, "revenue"), profitBeforeAds: completeCoordinate(bucket, "profitBeforeAds"),
      estimatedProfit: completeCoordinate(bucket, "estimatedProfit"), adTotal: completeCoordinate(bucket, "adSpend"),
      revenueKnown: chartNumber(bucket.completeTotals.revenue ?? bucket.knownTotals.revenue),
      profitBeforeAdsKnown: chartNumber(bucket.completeTotals.profitBeforeAds ?? bucket.knownTotals.profitBeforeAds),
      estimatedProfitKnown: chartNumber(bucket.completeTotals.estimatedProfit ?? bucket.knownTotals.estimatedProfit),
      adTotalKnown: chartNumber(bucket.completeTotals.adSpend ?? bucket.knownTotals.adSpend),
      partialAds: bucket.completeTotals.adSpend === null ? 1 : 0,
      movingAverage: chartNumber(averages[index]) };
    media.forEach((medium, mediumIndex) => {
      const own = bucket.byMedium.find(item => item.medium === medium);
      // Missing inputs remain a gap. A missing series may be zero only when its total is complete.
      row[`ad${mediumIndex}`] = chartNumber(own ? own.adSpend : bucket.completeTotals.adSpend !== null ? "0" : null);
      row[`share${mediumIndex}`] = compositionAvailable(bucket) ? chartNumber(own ? own.share : bucket.completeTotals.adSpend !== null ? "0" : null) : null;
    });
    return row;
  });
}
