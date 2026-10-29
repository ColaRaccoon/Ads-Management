import { ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { UnifiedManagementRepository } from "./management.repository";
import type { ReportQuery } from "./report-query";
import { datesIn, reportHash } from "./report-query";
import type { PublishedReportFact, ReportFact } from "./report-contract";
import { PLATFORM_COMPONENTS } from "./domain/platform-selection";
import type { Platform, SourceCoverage } from "./types";

export interface ReportScope { platform: Platform; scopeKey: string; label: string }
const MAX_RUNS = 20000, MAX_FACTS = 100000;
const at = (date: string) => new Date(`${date}T00:00:00Z`);
const day = (date: Date) => date.toISOString().slice(0, 10);
function bounded<T>(rows: T[], max: number): T[] {
  if (rows.length > max) throw new ServiceUnavailableException({ code: "UNIFIED_REPORT_TOO_LARGE", message: "조회 범위를 줄여 주세요." });
  return rows;
}
/** Metadata only: never queries sales, ads, public JSONB, credentials, or source adapters. */
export async function reportScopes(tx: Prisma.TransactionClient, platforms: Platform[]): Promise<ReportScope[]> {
  const connections = platforms.some(p => ["META", "GOOGLE", "CAFE24"].includes(p)) ? bounded(await tx.sourceConnection.findMany({
    where: { provider: { in: platforms.filter((p): p is "META" | "GOOGLE" | "CAFE24" => ["META", "GOOGLE", "CAFE24"].includes(p)) } },
    select: { id: true, provider: true, displayName: true }, orderBy: { id: "asc" }, take: 101
  }), 100) : [];
  const scopes: ReportScope[] = connections.map(c => ({ platform: c.provider as Platform, scopeKey: c.id, label: c.displayName }));
  const legacy = (process.env.UNIFIED_REPORT_LEGACY_PLATFORMS ?? "META,CAFE24").split(",");
  for (const platform of ["META", "CAFE24"] as const) if (platforms.includes(platform) && legacy.includes(platform))
    scopes.push({ platform, scopeKey: "LEGACY_UNBOUND", label: `${platform} 기존 CSV` });
  if (platforms.includes("COUPANG")) scopes.push({ platform: "COUPANG", scopeKey: "LEGACY_COUPANG_SINGLE_UPLOAD", label: "쿠팡 단일 업로드" });
  if (platforms.includes("NAVER")) for (const scopeKey of [...new Set((process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean))].sort()) {
    if (!/^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._:-]{0,255}$/.test(scopeKey)) throw new ServiceUnavailableException("네이버 스토어 허용 목록을 확인해 주세요.");
    scopes.push({ platform: "NAVER", scopeKey, label: "네이버 스토어" });
  }
  if (scopes.length > 50) throw new ServiceUnavailableException({ code: "UNIFIED_SCOPE_LIMIT", message: "서버 조회 범위를 나누어 주세요." });
  return scopes;
}
export function selectReportScopes(scopes: ReportScope[], requested?: string[]) {
  if (requested?.some(key => !scopes.some(scope => scope.scopeKey === key))) throw new ForbiddenException({ code: "UNIFIED_SCOPE_FORBIDDEN", message: "허용되지 않은 원천 범위입니다." });
  return requested === undefined ? scopes : scopes.filter(scope => requested.includes(scope.scopeKey));
}
export function missingCoverage(scope: ReportScope, date: string): SourceCoverage[] {
  return PLATFORM_COMPONENTS[scope.platform].map(component => ({ sourceSystem: scope.platform, platform: scope.platform, scopeKey: scope.scopeKey, date,
    component, participation: "INCLUDED", collectionState: "NOT_COLLECTED", rowsPresent: 0, zeroConfirmed: false,
    selectedSource: null, selectedUploadId: null, sourceVersion: null, collectedAt: null, sourceAsOf: null, calculatedAt: null, lastSuccessAt: null,
    sourceFingerprint: null, nameRuleVersion: "UNPUBLISHED", costRuleVersion: "UNPUBLISHED", mappedRows: 0, unmappedRows: 0,
    unmatchedAmount: null, missingCostRows: 0, missingFxAmount: null, unallocatedAmount: null,
    quality: { isEstimate: scope.platform === "NAVER", confidence: scope.platform === "NAVER" ? "ESTIMATED" : "SOURCE_REPORTED", issues: ["NOT_COLLECTED"] } }));
}

@Injectable()
export class UnifiedReportRepository {
  constructor(private readonly management: UnifiedManagementRepository) {}
  access(platforms: Platform[], scopeKeys?: string[], productNames: string[] = []) {
    return this.management.read(async tx => {
      if (productNames.length) {
        const products = await tx.unifiedProduct.findMany({ where: { canonicalName: { in: productNames } }, select: { canonicalName: true } });
        if (products.length !== productNames.length) throw new NotFoundException({ code: "UNIFIED_PRODUCT_NOT_FOUND", message: "기준 제품명을 찾을 수 없습니다." });
      }
      return selectReportScopes(await reportScopes(tx, platforms), scopeKeys);
    });
  }
  /** All selected pointers, versions, compact facts and failure markers share one read-only RR snapshot. */
  snapshot(query: ReportQuery, lookbackFrom?: string) {
    return this.management.read(async tx => {
      const catalog = await this.management.snapshot(tx);
      const scopes = selectReportScopes(await reportScopes(tx, query.platforms), query.scopeKeys);
      const partitions = scopes.map(s => ({ platform: s.platform, scopeKey: s.scopeKey }));
      const dateWhere = { OR: [{ businessDate: { gte: at(lookbackFrom ?? query.from), lte: at(query.to) } }, { businessDate: { gte: at(query.compareFrom), lte: at(query.compareTo) } }] };
      const where: Prisma.UnifiedSourcePublicationWhereInput = { AND: [{ OR: partitions }, dateWhere] };
      const publications = scopes.length ? bounded(await tx.unifiedSourcePublication.findMany({ where, include: { run: true }, orderBy: [
        { platform: "asc" }, { scopeKey: "asc" }, { businessDate: "asc" }, { sourceSystem: "asc" }
      ], take: MAX_RUNS + 1 }), MAX_RUNS) : [];
      const ids = publications.map(p => p.runId);
      const facts = ids.length ? bounded(await tx.unifiedDailyFact.findMany({ where: { runId: { in: ids }, ...(query.productName ? { OR: [{ productName: query.productName }, { productName: null }] } : {}) }, take: MAX_FACTS + 1 }), MAX_FACTS) : [];
      const coverageRows = ids.length ? bounded(await tx.unifiedSourceCoverage.findMany({ where: { runId: { in: ids } }, take: MAX_RUNS * 4 + 1 }), MAX_RUNS * 4) : [];
      const failures = scopes.length ? bounded(await tx.unifiedAggregationRun.findMany({ where: { AND: [{ OR: partitions }, dateWhere,
        { OR: [{ status: "FAILED" }, { status: "STAGING", attempts: { gt: 0 }, leaseExpiresAt: { lte: new Date() } }] }] },
        select: { id: true, platform: true, scopeKey: true, businessDate: true, startedAt: true, completedAt: true, leaseExpiresAt: true }, orderBy: { startedAt: "desc" }, take: MAX_RUNS + 1 }), MAX_RUNS) : [];
      const publicationById = new Map(publications.map(p => [p.runId, p]));
      const partitionKey = (platform: string, scope: string, date: string) => JSON.stringify([platform, scope, date]);
      const latestFailure = new Map<string, number>();
      for (const failure of failures) {
        const key = partitionKey(failure.platform, failure.scopeKey, day(failure.businessDate)), time = (failure.completedAt ?? failure.leaseExpiresAt ?? failure.startedAt).getTime();
        latestFailure.set(key, Math.max(time, latestFailure.get(key) ?? 0));
      }
      const reportFacts: PublishedReportFact[] = facts.map(fact => {
        const publication = publicationById.get(fact.runId)!;
        // Older/raw payload formats must never leak or masquerade as a ready report.
        const payload = fact.payload as unknown as ReportFact;
        if (typeof payload.rowsCount !== "number" || !payload.quality || !("completeAmountKrw" in payload))
          throw new ServiceUnavailableException({ code: "UNIFIED_REPORT_REBUILD_REQUIRED", message: "저장 집계 버전의 재집계가 필요합니다." });
        return { ...payload, platform: publication.platform as Platform, scopeKey: publication.scopeKey, date: day(publication.businessDate) };
      });
      if (query.productName && !catalog.products.some(p => p.canonicalName === query.productName) && !reportFacts.some(f => f.productName === query.productName))
        throw new NotFoundException({ code: "UNIFIED_PRODUCT_NOT_FOUND", message: "기준 제품명을 찾을 수 없습니다." });
      const coverage: SourceCoverage[] = coverageRows.map(c => {
        const publication = publicationById.get(c.runId)!;
        const details = c.details as unknown as SourceCoverage;
        const stale = (latestFailure.get(partitionKey(publication.platform, publication.scopeKey, day(publication.businessDate))) ?? 0) >
          (publication.run.publishedAt ?? publication.run.startedAt).getTime();
        return stale ? { ...details, collectionState: "STALE", quality: { ...details.quality, issues: [...new Set([...details.quality.issues, "LATEST_REBUILD_FAILED", "STALE_PREVIOUS_PUBLICATION"])] } } : details;
      });
      const dates = [...new Set([...datesIn(lookbackFrom ?? query.from, query.to), ...datesIn(query.compareFrom, query.compareTo)])].sort();
      if (dates.length * scopes.length > MAX_RUNS) throw new ServiceUnavailableException({ code: "UNIFIED_REPORT_TOO_LARGE", message: "조회 계정 또는 기간 범위를 줄여 주세요." });
      const coverageKeys = new Set(coverage.map(c => JSON.stringify([c.platform, c.scopeKey, c.date, c.component])));
      for (const scope of scopes) for (const date of dates) for (const expected of missingCoverage(scope, date)) {
        if (!coverageKeys.has(JSON.stringify([scope.platform, scope.scopeKey, date, expected.component]))) coverage.push(expected);
      }
      const availableDateRanges = scopes.length ? await tx.unifiedSourcePublication.groupBy({ by: ["platform", "scopeKey"], where: { OR: partitions },
        _min: { businessDate: true }, _max: { businessDate: true } }) : [];
      const inBase = (businessDate: Date) => {
        const value = day(businessDate);
        return value >= query.from && value <= query.to || value >= query.compareFrom && value <= query.compareTo;
      };
      const hashSnapshot = (base: boolean) => reportHash([
        publications.filter(p => !base || inBase(p.businessDate)).map(p => [p.runId, p.revision]),
        failures.filter(f => !base || inBase(f.businessDate)).map(f => [f.id, f.completedAt, f.leaseExpiresAt]), catalog.versions, scopes]);
      return { ...catalog, scopes, facts: reportFacts, coverage, publications, availableDateRanges: availableDateRanges.map(row => ({
        platform: row.platform, scopeKey: row.scopeKey, from: row._min.businessDate ? day(row._min.businessDate) : null, to: row._max.businessDate ? day(row._max.businessDate) : null })),
        snapshotHash: hashSnapshot(false), baseSnapshotHash: hashSnapshot(true) };
    });
  }
}
export type ReportSnapshot = Awaited<ReturnType<UnifiedReportRepository["snapshot"]>>;
