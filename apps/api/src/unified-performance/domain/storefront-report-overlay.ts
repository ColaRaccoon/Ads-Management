/** Structural input keeps the overlay independent of the persisted contract's version. */
export type StorefrontOverlayFact = {
  component: string;
  platform: string;
  scopeKey: string;
  date: string;
  marketplace: string | null;
  medium: string | null;
  productName?: string | null;
  saleUnitName?: string | null;
  rowsCount?: number;
  amountKrw?: string | null;
  completeAmountKrw?: string | null;
  profitBeforeAds?: string | null;
  completeProfitBeforeAds?: string | null;
  persistedNetProfit?: string | null;
  persistedAdSpend?: string | null;
};

const partitionKey = (fact: StorefrontOverlayFact) => JSON.stringify([fact.scopeKey, fact.date]);
function isPartitionMarker(fact: StorefrontOverlayFact) {
  return fact.saleUnitName === "PARTITION_MARKER" && fact.productName === null && fact.rowsCount === 0 &&
    [fact.amountKrw, fact.completeAmountKrw, fact.profitBeforeAds, fact.completeProfitBeforeAds, fact.persistedNetProfit, fact.persistedAdSpend].every(value => value == null);
}
function nativeChannel(fact: StorefrontOverlayFact): "META" | "YOUTUBE" | null {
  if (fact.component !== "STOREFRONT_RESULT" || fact.platform !== "CAFE24") return null;
  if (fact.saleUnitName === "PARTITION_MARKER" && !isPartitionMarker(fact)) return null;
  if (fact.marketplace === "CAFE24_META" && fact.medium === "META") return "META";
  if (fact.marketplace === "CAFE24_YOUTUBE" && fact.medium === "GOOGLE") return "YOUTUBE";
  return null;
}

/**
 * A complete pair of channel markers replaces only its own legacy Cafe24 sale partition.
 * Numeric zero and unknown amounts are both legitimate persisted markers; no amounts,
 * costs, quality or attribution are synthesized here. Unpaired/invalid result facts keep
 * their original component, so they cannot be aggregated as SALE alongside legacy sales.
 * Product-independent PARTITION_MARKER facts establish readiness after SQL product filtering
 * but always retain STOREFRONT_RESULT: a marker is never a zero-valued SALE.
 * The caller remains responsible for selected-ad profit math and monetary aggregation.
 */
export function overlayStorefrontResults<T extends StorefrontOverlayFact>(facts: readonly T[]): T[] {
  const channels = new Map<string, Set<"META" | "YOUTUBE">>();
  for (const fact of facts) {
    const channel = nativeChannel(fact);
    if (!channel) continue;
    const key = partitionKey(fact), markers = channels.get(key) ?? new Set<"META" | "YOUTUBE">();
    markers.add(channel); channels.set(key, markers);
  }
  const ready = new Set([...channels].filter(([, markers]) => markers.has("META") && markers.has("YOUTUBE")).map(([key]) => key));
  return facts.flatMap(fact => {
    if (!ready.has(partitionKey(fact))) return [fact];
    if (fact.component === "SALE" && fact.platform === "CAFE24" && fact.marketplace === "CAFE24") return [];
    if (isPartitionMarker(fact)) return [fact];
    return nativeChannel(fact) ? [{ ...fact, component: "SALE" } as T] : [fact];
  });
}
