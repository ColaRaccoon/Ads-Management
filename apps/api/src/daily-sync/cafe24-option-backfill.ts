/** Pure projection used by the one-off option recovery command. No parsing of names. */
export function cafe24OriginalOptionItems(value: unknown) {
  if (!Array.isArray(value)) throw new Error("OPTION_ITEMS_REQUIRED");
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("OPTION_ITEM_INVALID");
    const item = raw as Record<string, unknown>;
    const id = String(item.order_item_code ?? ""), productNo = String(item.product_no ?? "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(productNo) || seen.has(id))
      throw new Error("OPTION_ITEM_IDENTITY_INVALID");
    if (typeof item.option_value !== "string" || item.option_value.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(item.option_value)) throw new Error("OPTION_VALUE_INVALID");
    seen.add(id);
    return { lineOrderNo: id, productNo, optionValue: item.option_value };
  });
}
