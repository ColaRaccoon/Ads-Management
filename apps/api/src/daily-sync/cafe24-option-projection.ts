// The source components are independently bounded. Preserve the exact
// product_name(option_value) identity, including both delimiters.
export const CAFE24_OPTION_COMPONENT_LIMIT = 256;
// Orders may concatenate several selected option labels into one value.
// Bound it independently from the product name and never truncate either.
export const CAFE24_OPTION_VALUE_LIMIT = 1024;
export const CAFE24_OPTION_COMPOSITION_LIMIT = CAFE24_OPTION_COMPONENT_LIMIT + CAFE24_OPTION_VALUE_LIMIT + 2;
// The legacy business key is indexed as text. Leave room for index tuple
// metadata and the other indexed columns; reject oversized keys before writes.
export const CAFE24_BUSINESS_KEY_BYTE_LIMIT = 2304;

export function cafe24OptionCompositionFits(value: unknown): value is string {
  return typeof value === "string" && value.length <= CAFE24_OPTION_COMPOSITION_LIMIT;
}
