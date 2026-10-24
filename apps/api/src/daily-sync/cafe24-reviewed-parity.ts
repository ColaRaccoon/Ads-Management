/** Review may bridge repeated ASCII spaces in a product-name prefix only.
 * The provider item identity and the complete option suffix remain exact.
 * Original strings and their canonical source links are never rewritten. */
export type Cafe24ReviewIdentity = {
  orderNo: string; lineOrderNo: string; productNo: string;
  productName: string; optionName: string;
};

export function cafe24StableItemKey(row: Pick<Cafe24ReviewIdentity,
  "orderNo" | "lineOrderNo" | "productNo">): string {
  return JSON.stringify([row.orderNo, row.lineOrderNo, row.productNo]);
}

export function cafe24ProductPrefixSpaceDifference(api: Cafe24ReviewIdentity,
  csv: Cafe24ReviewIdentity): boolean {
  if (cafe24StableItemKey(api) !== cafe24StableItemKey(csv) ||
      api.optionName === csv.optionName ||
      !api.optionName.startsWith(`${api.productName}(`)) return false;
  const suffix = api.optionName.slice(api.productName.length);
  if (!csv.optionName.endsWith(suffix)) return false;
  const csvPrefix = csv.optionName.slice(0, -suffix.length);
  const collapse = (value: string) => value.replace(/ {2,}/g, " ");
  return csvPrefix !== api.productName &&
    collapse(csvPrefix) === collapse(api.productName);
}
