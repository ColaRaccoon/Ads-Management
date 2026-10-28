import { createHash } from "node:crypto";
import { PLATFORMS } from "../types";
import type { AmountQuality, Platform, SourceCoverage } from "../types";
import { ExactDecimal, money, quantizeMoney } from "./decimal";

export const PLATFORM_COMPONENTS = {
  META: ["AD_SPEND"], GOOGLE: ["AD_SPEND"],
  NAVER: ["SALE", "DIRECT_COST", "AD_SPEND", "COMMON_EXPENSE"],
  COUPANG: ["SALE", "DIRECT_COST", "AD_SPEND", "COMMON_EXPENSE"],
  CAFE24: ["SALE", "DIRECT_COST", "COMMON_EXPENSE"]
} as const;

export function normalizePlatforms(value?: unknown): Platform[] {
  if (value === undefined) return [...PLATFORMS];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new Error("platforms must be a JSON array."); }
  }
  if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some(p => typeof p !== "string" || !PLATFORMS.includes(p as Platform)))
    throw new Error("Unknown platform or invalid platforms array.");
  return PLATFORMS.filter(p => parsed.includes(p));
}

export function platformSelection(value?: unknown) {
  const selectedPlatforms = normalizePlatforms(value);
  const excludedPlatforms = PLATFORMS.filter(p => !selectedPlatforms.includes(p));
  const sale = selectedPlatforms.some(p => PLATFORM_COMPONENTS[p].some(c => c === "SALE"));
  const ads = selectedPlatforms.some(p => PLATFORM_COMPONENTS[p].some(c => c === "AD_SPEND"));
  const state = !selectedPlatforms.length ? "EMPTY_SELECTION" : !sale ? "AD_ONLY" : !ads ? "SALE_ONLY" : "SALE_AND_AD";
  return {
    selectedPlatforms, excludedPlatforms,
    scopeLabel: !selectedPlatforms.length ? "플랫폼을 선택하세요" : "선택 플랫폼 합계",
    profitLabel: state === "SALE_ONLY" ? "선택 범위 광고 전 이익" : "선택 범위 추정이익",
    metricAvailability: { state, revenue: sale, adSpend: ads, profitBeforeAds: sale, estimatedProfit: sale, mer: sale && ads },
    // Scope/date/product/rule versions must also be part of a complete request cache key.
    platformSelectionHash: createHash("sha256").update(JSON.stringify(selectedPlatforms)).digest("hex")
  };
}

/** No excluded source fetch is needed to build its selection marker. */
export function selectedCoverage(coverage: readonly SourceCoverage[], platforms: readonly Platform[]) {
  const selected = normalizePlatforms(platforms);
  return {
    coverage: coverage.filter(c => selected.includes(c.platform)).map(c => ({ ...c })),
    excludedByUser: PLATFORMS.filter(p => !selected.includes(p)).map(platform => ({ platform, participation: "EXCLUDED_BY_USER" as const }))
  };
}

/** Confidence and numeric availability are independent: ESTIMATED alone never removes a number. */
export function selectedAmount(
  entries: readonly { platform: Platform; amount: AmountQuality }[], platforms: readonly Platform[],
  /** Explicit applicable platforms for this metric; omission requires every selected platform. */
  expectedPlatforms: readonly Platform[] = platforms
): AmountQuality {
  const selected = normalizePlatforms(platforms);
  const amounts = entries.filter(e => selected.includes(e.platform)).map(e => e.amount);
  const missingPlatforms = normalizePlatforms(expectedPlatforms).filter(p => selected.includes(p) && !entries.some(e => e.platform === p));
  const present = amounts.filter(a => a.knownAmount !== null);
  const knownComponentCount = amounts.reduce((n, a) => n + a.knownComponentCount, 0);
  const expectedComponentCount = amounts.reduce((n, a) => n + a.expectedComponentCount, 0) + missingPlatforms.length;
  const complete = amounts.length > 0 && missingPlatforms.length === 0 && amounts.every(a => a.completeAmount !== null);
  return {
    knownAmount: present.length ? quantizeMoney(present.reduce((s, a) => s.plus(money(a.knownAmount)), new ExactDecimal(0))) : null,
    completeAmount: complete ? quantizeMoney(amounts.reduce((s, a) => s.plus(money(a.completeAmount)), new ExactDecimal(0))) : null,
    knownComponentCount, expectedComponentCount,
    isEstimate: amounts.some(a => a.isEstimate),
    confidence: amounts.some(a => a.confidence === "ESTIMATED") ? "ESTIMATED" : "SOURCE_REPORTED",
    issues: [...new Set([...amounts.flatMap(a => a.issues), ...missingPlatforms.map(p => `NOT_COLLECTED:${p}`)])].sort()
  };
}
