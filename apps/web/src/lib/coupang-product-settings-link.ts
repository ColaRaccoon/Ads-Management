export function coupangProductSettingsHref(productId: string) {
  return `/coupang/products?productId=${encodeURIComponent(productId)}`;
}

export function coupangProductIdFromSearch(search: string) {
  return new URLSearchParams(search).get("productId");
}
