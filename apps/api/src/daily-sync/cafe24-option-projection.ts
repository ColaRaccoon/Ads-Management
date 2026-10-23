// The source components are independently bounded. Preserve the exact
// product_name(option_value) identity, including both delimiters.
export const CAFE24_OPTION_COMPONENT_LIMIT = 256;
export const CAFE24_OPTION_COMPOSITION_LIMIT = CAFE24_OPTION_COMPONENT_LIMIT * 2 + 2;

export function cafe24OptionCompositionFits(value: unknown): value is string {
  return typeof value === "string" && value.length <= CAFE24_OPTION_COMPOSITION_LIMIT;
}
