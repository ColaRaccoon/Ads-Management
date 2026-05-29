export class AdsetNameNormalizer {
  static normalizeName(value: string): string {
    return value.trim().replace(/\s+/g, " ");
  }

  static toKey(value: string): string {
    return AdsetNameNormalizer.normalizeName(value).toLowerCase();
  }
}
