import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, type UnifiedAggregationRun, type UnifiedProduct, type UnifiedRule } from "@prisma/client";
import { managementVersions, UnifiedManagementRepository } from "./management.repository";
import type { ReportQuery } from "./report-query";
import { datesIn, reportHash } from "./report-query";
import type { PublishedReportFact, ReportFact } from "./report-contract";
import { PLATFORM_COMPONENTS } from "./domain/platform-selection";
import type { Platform, SourceCoverage } from "./types";

export interface ReportScope { platform: Platform; scopeKey: string; label: string }
type ReportScopePolicy = { legacyPlatforms: string; naverStoreIds: string };
const reportScopePolicy = (): ReportScopePolicy => ({
  legacyPlatforms: process.env.UNIFIED_REPORT_LEGACY_PLATFORMS ?? "META,CAFE24",
  naverStoreIds: process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS ?? ""
});
const MAX_RUNS = 20000, MAX_FACTS = 100000;
const day = (date: Date) => date.toISOString().slice(0, 10);
type ConnectionMetadata = { id: string; provider: string; displayName: string };
type RawRow = Record<string, unknown>;
type RawFrame = { products: RawRow[]; rules: RawRow[]; connections: ConnectionMetadata[];
  publications: Array<{ publication: RawRow; run: RawRow | null }>;
  facts: Array<{ run_id: string; payload: Prisma.JsonValue }>; coverage: Array<{ run_id: string; details: Prisma.JsonValue }>;
  failures: RawRow[]; ranges: Array<{ platform: string; scope_key: string; first_date: string | null; last_date: string | null }> };
const dateFields = new Set(["createdAt", "updatedAt", "validFrom", "validTo", "businessDate", "leaseExpiresAt", "startedAt", "completedAt", "publishedAt"]);
function hydrate<T>(row: RawRow): T {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => {
    const key = column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (value !== null && dateFields.has(key)) {
      const parsed = typeof value === "string" ? new Date(value) : new Date(NaN);
      if (!Number.isFinite(parsed.getTime())) throw new ServiceUnavailableException({ code: "UNIFIED_REPORT_REBUILD_REQUIRED", message: "저장 집계 날짜 형식을 확인해 주세요." });
      return [key, parsed];
    }
    // Do not recursively transform JSON payloads or turn exact decimal strings into numbers.
    return [key, value];
  })) as T;
}
function bounded<T>(rows: T[], max: number): T[] {
  if (rows.length > max) throw new ServiceUnavailableException({ code: "UNIFIED_REPORT_TOO_LARGE", message: "조회 범위를 줄여 주세요." });
  return rows;
}
/** Metadata only: never queries sales, ads, public JSONB, credentials, or source adapters. */
export async function reportScopes(tx: Prisma.TransactionClient, platforms: Platform[], policy = reportScopePolicy()): Promise<ReportScope[]> {
  const connections = platforms.some(p => ["META", "GOOGLE", "CAFE24"].includes(p)) ? bounded(await tx.sourceConnection.findMany({
    where: { provider: { in: platforms.filter((p): p is "META" | "GOOGLE" | "CAFE24" => ["META", "GOOGLE", "CAFE24"].includes(p)) } },
    select: { id: true, provider: true, displayName: true }, orderBy: { id: "asc" }, take: 101
  }), 100) : [];
  return scopesFromConnections(connections, platforms, policy);
}
function scopesFromConnections(connections: ConnectionMetadata[], platforms: Platform[], policy: ReportScopePolicy): ReportScope[] {
  const scopes: ReportScope[] = connections.map(c => ({ platform: c.provider as Platform, scopeKey: c.id, label: c.displayName }));
  const legacy = policy.legacyPlatforms.split(",");
  for (const platform of ["META", "CAFE24"] as const) if (platforms.includes(platform) && legacy.includes(platform))
    scopes.push({ platform, scopeKey: "LEGACY_UNBOUND", label: `${platform} 기존 CSV` });
  if (platforms.includes("COUPANG")) scopes.push({ platform: "COUPANG", scopeKey: "LEGACY_COUPANG_SINGLE_UPLOAD", label: "쿠팡 단일 업로드" });
  if (platforms.includes("NAVER")) for (const scopeKey of [...new Set(policy.naverStoreIds.split(",").map(s => s.trim()).filter(Boolean))].sort()) {
    if (!/^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._:-]{0,255}$/.test(scopeKey)) throw new ServiceUnavailableException("네이버 스토어 허용 목록을 확인해 주세요.");
    scopes.push({ platform: "NAVER", scopeKey, label: "네이버 스토어" });
  }
  if (scopes.length > 50) throw new ServiceUnavailableException({ code: "UNIFIED_SCOPE_LIMIT", message: "서버 조회 범위를 나누어 주세요." });
  return scopes;
}

/** One parameterized statement, one MVCC frame, no raw source/credential table reads. */
export function snapshotStatement(query: ReportQuery, lookbackFrom: string | undefined, policy: ReportScopePolicy) {
  const fixedScopes = scopesFromConnections([], query.platforms, policy);
  const selected = query.scopeKeys === undefined ? Prisma.sql`TRUE` :
    Prisma.sql`s.scope_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(query.scopeKeys)}::jsonb))`;
  const dateFilter = (alias: "p" | "r") => {
    const column = alias === "p" ? Prisma.sql`p.business_date` : Prisma.sql`r.business_date`;
    return Prisma.sql`((${column} BETWEEN ${lookbackFrom ?? query.from}::date AND ${query.to}::date)
      OR (${column} BETWEEN ${query.compareFrom}::date AND ${query.compareTo}::date))`;
  };
  const product = query.productName ? Prisma.sql`(f.product_name=${query.productName} OR f.product_name IS NULL)` : Prisma.sql`TRUE`;
  const metadataPlatforms = query.platforms.filter(p => ["META","GOOGLE","CAFE24"].includes(p));
  const connections = metadataPlatforms.length ? Prisma.sql`SELECT c.id,c.provider,c.display_name FROM meta_ads.source_connections c
    WHERE c.provider::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(metadataPlatforms)}::jsonb))
    ORDER BY c.id LIMIT 101` : Prisma.sql`SELECT NULL::uuid AS id,NULL::text AS provider,NULL::text AS display_name WHERE FALSE`;
  return Prisma.sql`WITH
    products AS MATERIALIZED (SELECT p.* FROM meta_ads.unified_products p ORDER BY p.id LIMIT 10001),
    rules AS MATERIALIZED (SELECT r.* FROM meta_ads.unified_rules r ORDER BY r.id LIMIT 10001),
    connections AS MATERIALIZED (${connections}),
    allowed_scopes AS MATERIALIZED (
      SELECT c.provider::text AS platform,c.id::text AS scope_key FROM connections c
      UNION ALL SELECT x->>'platform',x->>'scopeKey' FROM jsonb_array_elements(${JSON.stringify(fixedScopes)}::jsonb) x),
    selected_scopes AS MATERIALIZED (SELECT s.platform,s.scope_key FROM allowed_scopes s WHERE ${selected}),
    publications AS MATERIALIZED (
      SELECT p.*,to_jsonb(r) AS run FROM meta_ads.unified_source_publications p
      LEFT JOIN meta_ads.unified_aggregation_runs r ON r.id=p.run_id
      WHERE EXISTS (SELECT 1 FROM selected_scopes s WHERE s.platform=p.platform AND s.scope_key=p.scope_key) AND ${dateFilter("p")}
      ORDER BY p.platform,p.scope_key,p.business_date,p.source_system LIMIT 20001),
    facts AS MATERIALIZED (SELECT f.run_id,f.payload FROM meta_ads.unified_daily_facts f
      WHERE f.run_id IN (SELECT run_id FROM publications) AND ${product} LIMIT 100001),
    coverage AS MATERIALIZED (SELECT c.run_id,c.details FROM meta_ads.unified_source_coverage c
      WHERE c.run_id IN (SELECT run_id FROM publications) LIMIT 80001),
    failures AS MATERIALIZED (SELECT r.id,r.platform,r.scope_key,r.business_date,r.started_at,r.completed_at,r.lease_expires_at
      FROM meta_ads.unified_aggregation_runs r
      WHERE EXISTS (SELECT 1 FROM selected_scopes s WHERE s.platform=r.platform AND s.scope_key=r.scope_key) AND ${dateFilter("r")}
        AND (r.status='FAILED' OR (r.status='STAGING' AND r.attempts>0 AND r.lease_expires_at<=${new Date()}))
      ORDER BY r.started_at DESC LIMIT 20001),
    ranges AS (SELECT p.platform,p.scope_key,min(p.business_date) AS first_date,max(p.business_date) AS last_date
      FROM meta_ads.unified_source_publications p
      WHERE EXISTS (SELECT 1 FROM selected_scopes s WHERE s.platform=p.platform AND s.scope_key=p.scope_key)
      GROUP BY p.platform,p.scope_key)
    SELECT jsonb_build_object(
      'products',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM products p),'[]'::jsonb),
      'rules',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM rules r),'[]'::jsonb),
      'connections',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'provider',c.provider,'displayName',c.display_name) ORDER BY c.id) FROM connections c),'[]'::jsonb),
      'publications',COALESCE((SELECT jsonb_agg(jsonb_build_object('publication',to_jsonb(p)-'run','run',p.run) ORDER BY p.platform,p.scope_key,p.business_date,p.source_system) FROM publications p),'[]'::jsonb),
      'facts',COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM facts f),'[]'::jsonb),
      'coverage',COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM coverage c),'[]'::jsonb),
      'failures',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.started_at DESC) FROM failures r),'[]'::jsonb),
      'ranges',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.platform,r.scope_key) FROM ranges r),'[]'::jsonb)) AS frame`;
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
  // Instance-local to this fixed runtime DB role. Retain only unsettled reads, never report results.
  private readonly inFlight = new Map<string, ReturnType<UnifiedReportRepository["loadSnapshot"]>>();
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
    const policy = reportScopePolicy();
    // Caller permissions are checked by the service before every invocation. This workspace's
    // DB role is fixed per repository; server scope allowlists must also be part of sharing.
    const key = reportHash([query.from, query.to, query.compareFrom, query.compareTo, lookbackFrom ?? query.from,
      [...new Set(query.platforms)].sort(), query.scopeKeys === undefined ? null : [...new Set(query.scopeKeys)].sort(),
      query.productName ?? null, [...new Set(policy.legacyPlatforms.split(","))].sort(),
      [...new Set(policy.naverStoreIds.split(",").map(value => value.trim()).filter(Boolean))].sort()]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pinnedQuery = { ...query, platforms: [...query.platforms], scopeKeys: query.scopeKeys?.slice() };
    const pending = this.loadSnapshot(pinnedQuery, lookbackFrom, policy);
    this.inFlight.set(key, pending);
    const clear = () => { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); };
    // Handle both branches instead of an unobserved finally() rejection promise.
    void pending.then(clear, clear);
    return pending;
  }
  private loadSnapshot(query: ReportQuery, lookbackFrom: string | undefined, policy: ReportScopePolicy) {
    return this.management.read(async tx => {
      const [result] = await tx.$queryRaw<Array<{ frame: RawFrame }>>(snapshotStatement(query,lookbackFrom,policy));
      return result.frame;
    }).then(frame => {
      // The single statement already captured the complete MVCC frame. Pure
      // hydration and missing-day expansion must not keep a DB transaction open.
      const products = frame.products.map(row => hydrate<UnifiedProduct>(row)), rules = frame.rules.map(row => hydrate<UnifiedRule>(row));
      if (products.length > 10000 || rules.length > 10000) throw new BadRequestException({ code: "UNIFIED_CONFIGURATION_TOO_LARGE", message: "설정 범위를 나누어 주세요." });
      const catalog = { products, rules, versions: managementVersions(products,rules) };
      const scopes = selectReportScopes(scopesFromConnections(bounded(frame.connections,100),query.platforms,policy),query.scopeKeys);
      type Publication = Prisma.UnifiedSourcePublicationGetPayload<{ include: { run: true } }>;
      const publications = bounded(frame.publications,MAX_RUNS).map(row => {
        if (!row.run) throw new ServiceUnavailableException({ code:"UNIFIED_REPORT_REBUILD_REQUIRED",message:"발행 집계의 읽기 권한과 버전을 확인해 주세요." });
        return { ...hydrate<Omit<Publication,"run">>(row.publication),run:hydrate<UnifiedAggregationRun>(row.run) };
      });
      const facts = bounded(frame.facts,MAX_FACTS).map(row => ({runId:row.run_id,payload:row.payload}));
      const coverageRows = bounded(frame.coverage,MAX_RUNS*4).map(row => ({runId:row.run_id,details:row.details}));
      const failures = bounded(frame.failures,MAX_RUNS).map(row => hydrate<Pick<UnifiedAggregationRun,
        "id"|"platform"|"scopeKey"|"businessDate"|"startedAt"|"completedAt"|"leaseExpiresAt">>(row));
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
      const inBase = (businessDate: Date) => {
        const value = day(businessDate);
        return value >= query.from && value <= query.to || value >= query.compareFrom && value <= query.compareTo;
      };
      const hashSnapshot = (base: boolean) => reportHash([
        publications.filter(p => !base || inBase(p.businessDate)).map(p => [p.runId, p.revision]),
        failures.filter(f => !base || inBase(f.businessDate)).map(f => [f.id, f.completedAt, f.leaseExpiresAt]), catalog.versions, scopes]);
      return { ...catalog, scopes, facts: reportFacts, coverage, publications, availableDateRanges: frame.ranges.map(row => ({
        platform: row.platform, scopeKey: row.scope_key, from: row.first_date, to: row.last_date })),
        snapshotHash: hashSnapshot(false), baseSnapshotHash: hashSnapshot(true) };
    });
  }
}
export type ReportSnapshot = Awaited<ReturnType<UnifiedReportRepository["snapshot"]>>;
