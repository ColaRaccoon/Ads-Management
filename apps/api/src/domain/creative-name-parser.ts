const SETTING_SUFFIXES = new Set(["IG", "FB", "IG+FB", "FB+IG"]);
const METHOD_TOKENS = new Set(["인플연동"]);

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
    let parts = originalName
      .split("_")
      .map((part) => part.trim())
      .filter(Boolean);

    const dateCode = this.isDatePrefix(parts[0]) ? parts.shift() ?? null : null;
    let setting = this.isSettingSuffix(parts[parts.length - 1]) ? parts.pop()?.toUpperCase() ?? null : null;
    const method = parts.find((part) => this.isMethodToken(part)) ?? null;
    parts = parts.filter((part) => !this.isMethodToken(part));

    if (
      !setting &&
      dateCode &&
      parts.length >= 3 &&
      this.isMaterialNo(parts[parts.length - 2]) &&
      !this.isMaterialNo(parts[parts.length - 1])
    ) {
      setting = parts.pop() ?? null;
    }

    if (parts.length < 2) {
      return {
        originalName,
        dateCode,
        productName: parts[0] ?? originalName,
        materialNo: null,
        setting: setting ?? method,
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
      setting: setting ?? method,
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

  private isMethodToken(value: string | undefined) {
    return Boolean(value && METHOD_TOKENS.has(value));
  }

  private isMaterialNo(value: string | undefined) {
    return Boolean(value && (/^[A-Z]?\d+$/i.test(value) || /^\d+번소재$/i.test(value)));
  }
}
