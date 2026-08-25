const FORMULA_PREFIX = /^[\u0009\u000a\u000d \u00a0]*[=+\-@]/;

/**
 * Escapes external string values that spreadsheet applications may interpret
 * as formulas. Numeric values remain numeric so report calculations and number
 * formatting are not changed.
 */
export function safeExportCellValue<T extends string | number | null | undefined>(value: T): T | string {
  if (typeof value !== "string" || !FORMULA_PREFIX.test(value)) {
    return value;
  }
  return `'${value}`;
}
