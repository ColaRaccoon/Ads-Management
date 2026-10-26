export type GoogleAutomaticProduct = { id: string; name: string; displayName: string; isActive?: boolean };
export type GoogleCampaignMatch = { productId: string | null; warningCodes: string[] };

const nameKey = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

/** Request-local matcher: only the supplied active product names are aliases.
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
    const cached = cache.get(target);
    if (cached) return cached;
    const candidates = [...namesByProduct].filter(([, names]) => [...names].some(name => target.includes(name))).map(([id]) => id);
    const result: GoogleCampaignMatch = candidates.length === 1
      ? { productId: candidates[0], warningCodes: [] }
      : { productId: null, warningCodes: [candidates.length ? "AMBIGUOUS_CAMPAIGN_PRODUCT" : "CAMPAIGN_PRODUCT_NOT_FOUND"] };
    cache.set(target, result);
    return result;
  };
}
