import { ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { ReportFact } from "./report-contract";
import type { CatalogProduct, NameRule } from "./domain/product-name-resolver";
import { mapNativeProducts, mappingPlatform, NATIVE_NAME_FIELDS, type MappingGroup } from "./domain/native-product-mapping";
import { reportScopes } from "./report.repository";
import { range } from "./report-query";

export async function sourceProductInventory(tx: Prisma.TransactionClient, query: { from: string; to: string },
  products: CatalogProduct[], rules: NameRule[], version: string) {
  const dates = range(query.from, query.to, 92);
  const scopes = await reportScopes(tx, ["CAFE24", "NAVER", "COUPANG"]);
  const publications = scopes.length ? await tx.unifiedSourcePublication.findMany({ where: {
    OR: scopes.map(scope => ({ platform: scope.platform, scopeKey: scope.scopeKey })),
    businessDate: { gte: new Date(`${dates.from}T00:00:00Z`), lte: new Date(`${dates.to}T00:00:00Z`) }
  }, select: { runId: true, scopeKey: true, businessDate: true }, take: 5001 }) : [];
  if (publications.length > 5000) throw new ServiceUnavailableException("상품 조회 기간을 줄여 주세요.");
  const facts = publications.length ? await tx.unifiedDailyFact.findMany({ where: {
    runId: { in: publications.map(row => row.runId) }, component: "NATIVE_RESULT"
  }, select: { runId: true, payload: true }, take: 100001 }) : [];
  if (facts.length > 100000) throw new ServiceUnavailableException("상품 조회 기간을 줄여 주세요.");
  const byRun = new Map(publications.map(row => [row.runId, row]));
  const inventory = new Map<string, {
    key: string; group: string; platform: string; scopeKey: string; sourceName: string; nameField: string;
    firstDate: string; lastDate: string; publishedName: string | null; targetName: string | null;
    matchStatus: string; pending: boolean; ruleIds: string[];
  }>();
  const publishedOptions = new Map(facts.flatMap(fact => {
    const row = (fact.payload as unknown as ReportFact).nativeResult;
    return row?.audit?.optionParentProductKey ? [[JSON.stringify([fact.runId, row.productKey]), row] as const] : [];
  }));
  const expanded = facts.flatMap(fact => {
    const parent = (fact.payload as unknown as ReportFact).nativeResult;
    if (!parent?.sourceOptions?.length) return [fact];
    return [fact, ...parent.sourceOptions.flatMap(option => {
      const productKey = `${parent.productKey}:option:${option.key}`;
      if (publishedOptions.has(JSON.stringify([fact.runId, productKey]))) return [];
      return [{ runId: fact.runId, payload: { nativeResult: { kind: "PRODUCT", group: "NAVER", productKey,
        productName: null, quantity: option.quantity, revenue: option.revenue, adSpend: option.adSpend,
        netProfit: option.netProfit, profitBeforeAds: option.profitBeforeAds, sourceUpdatedAt: parent.sourceUpdatedAt, issues: [],
        audit: { sourceProductName: option.name, optionParentProductKey: parent.productKey } } } as unknown as typeof fact.payload }];
    })];
  });
  for (const fact of expanded) {
    const row = (fact.payload as unknown as ReportFact).nativeResult, publication = byRun.get(fact.runId);
    if (!row || !publication || row.kind !== "PRODUCT" || row.audit?.isStoreLevel === "true") continue;
    const sourceName = row.audit?.sourceProductName ?? row.productName;
    if (!sourceName) continue;
    const date = publication.businessDate.toISOString().slice(0, 10);
    const group: MappingGroup = row.audit?.optionParentProductKey ? "NAVER_OPTION" : row.group;
    const key = JSON.stringify([group, publication.scopeKey, sourceName]);
    const previous = inventory.get(key);
    if (previous && previous.lastDate > date) { previous.firstDate = date < previous.firstDate ? date : previous.firstDate; continue; }
    const mapped = mapNativeProducts([row], publication.scopeKey, date, products, rules, version)[0];
    inventory.set(key, { key, group, platform: mappingPlatform(group), scopeKey: publication.scopeKey,
      sourceName, nameField: NATIVE_NAME_FIELDS[group], firstDate: previous?.firstDate && previous.firstDate < date ? previous.firstDate : date,
      lastDate: date, publishedName: row.productName, targetName: mapped.audit?.mappingStatus === "MATCHED" ? mapped.productName : null,
      matchStatus: mapped.audit?.mappingStatus ?? "UNMATCHED",
      pending: group === "NAVER_OPTION" && row.productName === null && mapped.audit?.mappingStatus !== "MATCHED" ? false : mapped.productName !== row.productName,
      ruleIds: mapped.audit?.mappingRuleIds?.split(",").filter(Boolean) ?? [] });
  }
  return { ...dates, basis: "PUBLISHED_PRODUCT_RESULTS", products: [...inventory.values()].sort((a, b) =>
    a.group.localeCompare(b.group) || a.sourceName.localeCompare(b.sourceName)),
    note: "선택 기간에 발행된 원천 상품만 표시합니다. 판매 이력이 없거나 미수집·미발행인 상품은 상품명을 직접 입력하세요." };
}
