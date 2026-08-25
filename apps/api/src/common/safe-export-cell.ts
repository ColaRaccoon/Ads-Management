const FORMULA_PREFIX = /^[\u0009\u000a\u000d \u00a0]*[=+\-@]/;

/**
 * Prevents external strings from being interpreted as spreadsheet formulas.
 * Non-string values intentionally keep their native type.
 */
export function safeExportCellValue<T>(value: T): T | string {
  if (typeof value !== "string" || !FORMULA_PREFIX.test(value)) {
    return value;
  }
  return `'${value}`;
}
