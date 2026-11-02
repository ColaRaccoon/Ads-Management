import { createHash } from "node:crypto";
import type { GooglePerformanceMapping } from "@prisma/client";

export type GoogleCampaignKeyword = { connectionId: string; keyword: string; productId: string | null; startDate: string; endDate: string | null };
export const googleKeywordKey = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
// Use a separate identity namespace in existing audited Google mapping storage.
// Legacy campaign IDs are never interpreted as keywords; no fact/schema changes.
export const googleKeywordIdentity = (value: string) => createHash("sha256").update(JSON.stringify(["GOOGLE_CAMPAIGN_KEYWORD", googleKeywordKey(value)])).digest("hex");
export function googleKeywordFromMapping(row: GooglePerformanceMapping): GoogleCampaignKeyword | null {
  return row.kind === "CAMPAIGN" && row.campaignId && row.identityKey === googleKeywordIdentity(row.campaignId)
    ? { connectionId: row.connectionId, keyword: row.campaignId, productId: row.productId,
      startDate: row.startDate.toISOString().slice(0, 10), endDate: row.endDate?.toISOString().slice(0, 10) ?? null } : null;
}

export type GoogleAutomaticProduct = { id: string; name: string; displayName: string; isActive?: boolean };
export type GoogleCampaignMatch = { productId: string | null; warningCodes: string[] };

const nameKey = googleKeywordKey;

// Google uses this established short label for one fixed product. Do not infer
// other shortened names, and retain token boundaries before removing spaces.
const googleAliases = [{ canonicalName: nameKey("베놈무릎보호대"),
  pattern: /(^|[^\p{L}\p{N}])베놈(?=$|[^\p{L}\p{N}])/u }];

/** Request-local matcher: supplied active names plus explicit Google aliases.
 * Legacy campaign IDs and other channels' rules are never interpreted as keywords. */
export function createGoogleCampaignMatcher(products: readonly GoogleAutomaticProduct[], keywords: readonly GoogleCampaignKeyword[] = []) {
  const namesByProduct = new Map<string, Set<string>>();
  for (const product of products) {
    if (product.isActive === false) continue;
    const names = namesByProduct.get(product.id) ?? new Set<string>();
    for (const value of [product.name, product.displayName]) {
      const key = nameKey(value);
      if (key) names.add(key);
    }
    namesByProduct.set(product.id, names);
  }
  const cache = new Map<string, GoogleCampaignMatch>();
  return (campaignName: string, scope?: { connectionId: string; date: string }): GoogleCampaignMatch => {
    const target = nameKey(campaignName);
    const tokenTarget = campaignName.normalize("NFKC").toLowerCase();
    // Whitespace is significant for alias boundaries, so alias results cannot
    // share the whitespace-free cache key used for full-name comparisons.
    const cacheKey = JSON.stringify([tokenTarget, scope?.connectionId, scope?.date]);
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const nameCandidates = [...namesByProduct].filter(([, names]) =>
      [...names].some(name => target.includes(name)) ||
      googleAliases.some(alias => names.has(alias.canonicalName) && alias.pattern.test(tokenTarget))).map(([id]) => id);
    const candidates = [...new Set([...nameCandidates, ...keywords.filter(rule => scope && rule.connectionId === scope.connectionId &&
      rule.startDate <= scope.date && (!rule.endDate || scope.date <= rule.endDate) && rule.productId && namesByProduct.has(rule.productId) &&
      googleKeywordKey(rule.keyword) && target.includes(googleKeywordKey(rule.keyword))).map(rule => rule.productId!)])];
    const result: GoogleCampaignMatch = candidates.length === 1
      ? { productId: candidates[0], warningCodes: [] }
      : { productId: null, warningCodes: [candidates.length ? "AMBIGUOUS_CAMPAIGN_PRODUCT" : "CAMPAIGN_PRODUCT_NOT_FOUND"] };
    cache.set(cacheKey, result);
    return result;
  };
}
