import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, UnifiedProduct, UnifiedRule } from "@prisma/client";
import { RulePreviewInput, CONFIG_PLATFORMS } from "./management.dto";
import { ManagementTransaction } from "./management.repository";
import { normalizePlatforms } from "./domain/platform-selection";
import { range } from "./report-query";
import { reportScopes } from "./report.repository";
import type { ReportFact } from "./report-contract";

const Decimal = Prisma.Decimal.clone({ precision: 80 });
export function affectedConfigurationScope(input: Pick<RulePreviewInput, "platform" | "scopeKey">, before?: Pick<UnifiedRule, "platform" | "scopeKey"> | null) {
  const configs = before ? [input, before] : [input];
  const platforms = configs.some(c => c.platform == null) ? [...CONFIG_PLATFORMS] : [...new Set(configs.map(c => c.platform!))];
  const scopeKeys = configs.some(c => c.scopeKey == null) ? undefined : [...new Set(configs.map(c => c.scopeKey!))];
  return { platforms, ...(scopeKeys ? { scopeKeys } : {}) };
}
/** Conservative review envelope; hashed name evidence cannot predict reclassification without a worker replay. */
export async function configurationImpact(tx: ManagementTransaction, input: RulePreviewInput, before: UnifiedRule | null | undefined, products: UnifiedProduct[]) {
  let dates: { from: string; to: string };
  let selectedPlatforms: ReturnType<typeof normalizePlatforms>;
  try { dates = range(input.impactFrom, input.impactTo, 92); selectedPlatforms = normalizePlatforms(input.previewPlatforms); }
  catch { throw new BadRequestException({ code: "UNIFIED_IMPACT_INVALID", message: "미리보기 기간은 양끝을 포함해 92일 이하로 지정하고 플랫폼 목록을 확인해 주세요." }); }
  const affectedScope = affectedConfigurationScope(input, before);
  const platforms = selectedPlatforms.filter(p => affectedScope.platforms.includes(p));
  const scopes = (await reportScopes(tx, platforms)).filter(s => !affectedScope.scopeKeys || affectedScope.scopeKeys.includes(s.scopeKey));
  const at = (s: string) => new Date(`${s}T00:00:00Z`);
  const publications = scopes.length ? await tx.unifiedSourcePublication.findMany({
    where: { OR: scopes.map(s => ({ platform: s.platform, scopeKey: s.scopeKey })), businessDate: { gte: at(dates.from), lte: at(dates.to) } }, select: { runId: true, platform: true, scopeKey: true, businessDate: true }, take: 5001
  }) : [];
  if (publications.length > 5000) throw new ServiceUnavailableException({ code: "UNIFIED_IMPACT_TOO_LARGE", message: "미리보기 기간을 줄여 주세요." });
  const rows = publications.length ? await tx.unifiedDailyFact.findMany({ where: { runId: { in: publications.map(p => p.runId) } }, select: { runId: true, payload: true }, take: 100001 }) : [];
  if (rows.length > 100000) throw new ServiceUnavailableException({ code: "UNIFIED_IMPACT_TOO_LARGE", message: "미리보기 기간을 줄여 주세요." });
  const facts = rows.map(row => row.payload as unknown as ReportFact);
  if (facts.some(f => !f || !["SALE", "AD_SPEND", "COMMON_EXPENSE", "SHIPPING_INCOME"].includes(f.component) ||
      (f.productName !== null && typeof f.productName !== "string") ||
      (f.amountKrw !== null && (typeof f.amountKrw !== "string" || !/^-?\d+(?:\.\d+)?$/.test(f.amountKrw)))))
    throw new ServiceUnavailableException({ code: "UNIFIED_REPORT_REBUILD_REQUIRED", message: "기존 발행 결과의 형식을 확인하고 재집계해 주세요." });
  const sum = (component: string) => {
    const amounts = facts.filter(f => f.component === component && f.amountKrw != null).map(f => f.amountKrw!);
    return amounts.length ? amounts.reduce((n, v) => n.plus(v), new Decimal(0)).toFixed(6) : null;
  };
  const revenue = sum("SALE");
  const targetNames = new Set(((input.payload.targets ?? []) as { productName: string }[]).map(t => t.productName));
  const zeroDenominator = input.kind === "ALLOCATION" && input.payload.method === "REVENUE_SHARE" && (!publications.length || publications.some(p => {
    const selected = rows.filter(r => r.runId === p.runId).map(r => r.payload as unknown as ReportFact)
      .filter(f => f.component === "SALE" && f.productName && targetNames.has(f.productName));
    if (selected.some(f => f.amountKrw == null)) return true;
    const weights = [...targetNames].map(name => selected.filter(f => f.productName === name).reduce((n, f) => n.plus(f.amountKrw!), new Decimal(0)));
    return weights.some(w => w.lt(0)) || weights.reduce((n, w) => n.plus(w), new Decimal(0)).lte(0);
  }));
  return { basis: "PUBLISHED_SCOPE_REVIEW_TOTALS" as const, ...dates, selectedPlatforms,
    excludedPlatforms: CONFIG_PLATFORMS.filter(p => !selectedPlatforms.includes(p)),
    affectedProducts: [...new Set([...products.map(p => p.canonicalName), ...facts.map(f => f.productName).filter((p): p is string => p !== null)])].sort(),
    publishedRevenue: revenue, publishedAdSpend: sum("AD_SPEND"), publishedRows: rows.length,
    unallocatedRows: facts.filter(f => f.productName == null).length,
    zeroDenominator,
    warnings: ["CONSERVATIVE_SCOPE_TOTALS_NOT_PREDICTED_CHANGE", ...(rows.length ? [] : ["NO_PUBLISHED_DATA"]),
      ...(dates.from < input.validFrom || input.validTo && dates.to > input.validTo ? ["PREVIEW_INCLUDES_DATES_OUTSIDE_RULE"] : [])] };
}
