const SETTING_SUFFIXES = new Set(["IG", "FB", "IG+FB", "FB+IG"]);

export type CreativeNameParts = {
  originalName: string;
  dateCode: string | null;
  productName: string | null;
  materialNo: string | null;
  setting: string | null;
  creativeKey: string;
  displayName: string;
  parseStatus: "PARSED" | "FALLBACK";
};

export class CreativeNameParser {
  parse(adName: string): CreativeNameParts {
    const originalName = adName.trim();
    const parts = originalName
      .split("_")
      .map((part) => part.trim())
      .filter(Boolean);

    const dateCode = this.isDatePrefix(parts[0]) ? parts.shift() ?? null : null;
    const setting = this.isSettingSuffix(parts[parts.length - 1]) ? parts.pop()?.toUpperCase() ?? null : null;

    if (parts.length < 2) {
      return {
        originalName,
        dateCode,
        productName: parts[0] ?? originalName,
        materialNo: null,
        setting,
        creativeKey: originalName,
        displayName: originalName,
        parseStatus: "FALLBACK"
      };
    }

    const materialNo = parts.pop() ?? null;
    const productName = parts.join("_");
    const creativeKey = `${productName}_${materialNo}`;

    return {
      originalName,
      dateCode,
      productName,
      materialNo,
      setting,
      creativeKey,
      displayName: creativeKey,
      parseStatus: "PARSED"
    };
  }

  private isDatePrefix(value: string | undefined) {
    return Boolean(value && (/^\d{4}$/.test(value) || /^\d{6}$/.test(value) || /^\d{8}$/.test(value)));
  }

  private isSettingSuffix(value: string | undefined) {
    return Boolean(value && SETTING_SUFFIXES.has(value.toUpperCase()));
  }
}
