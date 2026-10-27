export type GoogleAutomaticProduct = { id: string; name: string; displayName: string; isActive?: boolean };
export type GoogleCampaignMatch = { productId: string | null; warningCodes: string[] };

const nameKey = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

// Google uses this established short label for one fixed product. Do not infer
// other shortened names, and retain token boundaries before removing spaces.
const googleAliases = [{ canonicalName: nameKey("베놈무릎보호대"),
  pattern: /(^|[^\p{L}\p{N}])베놈(?=$|[^\p{L}\p{N}])/u }];

/** Request-local matcher: supplied active names plus explicit Google aliases.
 * Campaign IDs, prior manual mappings and other channels' rules are never inputs. */
export function createGoogleCampaignMatcher(products: readonly GoogleAutomaticProduct[]) {
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
  return (campaignName: string): GoogleCampaignMatch => {
    const target = nameKey(campaignName);
    const tokenTarget = campaignName.normalize("NFKC").toLowerCase();
    // Whitespace is significant for alias boundaries, so alias results cannot
    // share the whitespace-free cache key used for full-name comparisons.
    const cached = cache.get(tokenTarget);
    if (cached) return cached;
    const candidates = [...namesByProduct].filter(([, names]) =>
      [...names].some(name => target.includes(name)) ||
      googleAliases.some(alias => names.has(alias.canonicalName) && alias.pattern.test(tokenTarget))).map(([id]) => id);
    const result: GoogleCampaignMatch = candidates.length === 1
      ? { productId: candidates[0], warningCodes: [] }
      : { productId: null, warningCodes: [candidates.length ? "AMBIGUOUS_CAMPAIGN_PRODUCT" : "CAMPAIGN_PRODUCT_NOT_FOUND"] };
    cache.set(tokenTarget, result);
    return result;
  };
}
