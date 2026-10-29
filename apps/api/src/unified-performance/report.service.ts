import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { UnifiedAggregationRepository } from "./aggregation.repository";
import { UnifiedReportRepository, type ReportSnapshot } from "./report.repository";
import { compareMedia, compareTotals, scopePolicyComponents, summarizeReport } from "./domain/report-calculation";
import { PLATFORM_COMPONENTS, platformSelection } from "./domain/platform-selection";
import { assertUnifiedEnabled } from "./management.service";
import { datesIn, daysBetween, parseReportQuery, range, reportBuckets, reportHash, shiftDate, stringArray, type ReportQuery } from "./report-query";
import { parseRelationshipQuery } from "./relationship-query";
import { relationshipDays } from "./relationship-input";
import { calculateRelationships } from "./domain/relationship-calculation";
import { CONTRACT_VERSION, PLATFORMS, type ComponentKind, type SourceCoverage } from "./types";
import { REPORT_CALCULATION_VERSION } from "./report-contract";

type Actor = Pick<AuthenticatedUser, "id" | "permissions">;
type ViewKind = "summary" | "timeseries" | "diagnostics" | "options" | "relationships";
const date = (value: Date) => value.toISOString().slice(0, 10);
const safeIssues = (issues: readonly string[]) => [...new Set(issues.filter(issue => /^[A-Z][A-Z0-9_:.|/-]{0,159}$/.test(issue)))].sort();
const safeCoverage = (coverage: SourceCoverage[]) => coverage.map(c => ({
  sourceSystem: c.sourceSystem, platform: c.platform, scopeKey: c.scopeKey, date: c.date, component: c.component,
  participation: c.participation, collectionState: c.collectionState, rowsPresent: c.rowsPresent, zeroConfirmed: c.zeroConfirmed,
  sourceAsOf: c.sourceAsOf, calculatedAt: c.calculatedAt, lastSuccessAt: c.lastSuccessAt, mappedRows: c.mappedRows, unmappedRows: c.unmappedRows,
  unmatchedAmount: c.unmatchedAmount, missingCostRows: c.missingCostRows, missingFxAmount: c.missingFxAmount, unallocatedAmount: c.unallocatedAmount,
  isEstimate: c.quality.isEstimate, issues: safeIssues(c.quality.issues)
}));
function allowed(actor: Actor, permission: "data.read" | "operations.run") {
  assertUnifiedEnabled();
  if (!actor?.permissions?.includes(permission)) throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "실행 권한이 없습니다." });
}
function applicable(snapshot: ReportSnapshot, productName?: string) {
  const product = snapshot.products.find(p => p.canonicalName === productName);
  if (!productName) return { facts: snapshot.facts, coverage: snapshot.coverage };
  const key = (platform: string, scope: string, day: string) => JSON.stringify([platform, scope, day]);
  const publications = new Map(snapshot.publications.map(p => [key(p.platform, p.scopeKey, date(p.businessDate)), p]));
  const components = (platform: SourceCoverage["platform"], scopeKey: string, day: string) => {
    const publication = publications.get(key(platform, scopeKey, day));
    if (publication) {
      const versions = publication.run.versions as { participationOverrides?: Record<string, ComponentKind[]> };
      return versions.participationOverrides?.[productName!] ?? [...PLATFORM_COMPONENTS[platform]];
    }
    return product ? scopePolicyComponents(snapshot.rules, product.id, platform, scopeKey, day, PLATFORM_COMPONENTS[platform]) : [...PLATFORM_COMPONENTS[platform]];
  };
  return { facts: snapshot.facts.filter(f => components(f.platform, f.scopeKey, f.date).includes(
    f.component === "SHIPPING_INCOME" ? "COMMON_EXPENSE" : f.component as ComponentKind)),
  coverage: snapshot.coverage.map(c => components(c.platform, c.scopeKey, c.date).includes(c.component) ? c : { ...c, participation: "NOT_APPLICABLE" as const }) };
}
function period(scope: ReturnType<typeof applicable>, query: ReportQuery, from: string, to: string, productName?: string) {
  const facts = scope.facts.filter(f => f.date >= from && f.date <= to), coverage = scope.coverage.filter(c => c.date >= from && c.date <= to);
  return { ...summarizeReport(facts, coverage, { platforms: query.platforms, productName }), coverage };
}
function metricAvailability(coverage: SourceCoverage[], selectedCount: number) {
  const revenue = coverage.some(c => c.participation === "INCLUDED" && c.component === "SALE"),
    adSpend = coverage.some(c => c.participation === "INCLUDED" && c.component === "AD_SPEND");
  return { state: !selectedCount ? "EMPTY_SELECTION" : !revenue && !adSpend ? "NOT_APPLICABLE" : !revenue ? "AD_ONLY" : !adSpend ? "SALE_ONLY" : "SALE_AND_AD",
    revenue, adSpend, profitBeforeAds: revenue, estimatedProfit: revenue, mer: revenue && adSpend };
}
function page<T>(items: T[], query: ReportQuery, snapshotHash: string, kind: ViewKind) {
  const key = reportHash([kind, query.selectionHash, snapshotHash]);
  let offset = 0;
  if (query.cursor) {
    try {
      const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (value.key !== key) throw new ConflictException({ code: "UNIFIED_CURSOR_CHANGED", message: "발행 버전 또는 조회 조건이 바뀌었습니다. 첫 페이지부터 조회해 주세요." });
      if (!Number.isInteger(value.offset) || value.offset < 0 || value.offset > items.length) throw new Error("offset");
      offset = value.offset;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new BadRequestException({ code: "UNIFIED_CURSOR_INVALID", message: "cursor가 올바르지 않습니다." });
    }
  }
  return { items: items.slice(offset, offset + query.limit), total: items.length,
    nextCursor: offset + query.limit < items.length ? Buffer.from(JSON.stringify({ key, offset: offset + query.limit })).toString("base64url") : null };
}

@Injectable()
export class UnifiedReportService {
  constructor(private readonly repository: UnifiedReportRepository, private readonly aggregation: UnifiedAggregationRepository) {}
  async read(kind: ViewKind, input: Record<string, unknown>, actor: Actor) {
    allowed(actor, "data.read");
    const query = parseReportQuery(input);
    const analysisSettings = kind === "relationships" ? parseRelationshipQuery(input, query) : undefined;
    const lookbackFrom = analysisSettings ? shiftDate(query.from, -14) : undefined;
    const snapshot = await this.repository.snapshot(query, lookbackFrom);
    // Participation belongs to this immutable request snapshot, not each time bucket.
    const scopes = new Map<string | undefined, ReturnType<typeof applicable>>();
    const scopeFor = (productName?: string) => {
      let scope = scopes.get(productName);
      if (!scope) { scope = applicable(snapshot, productName); scopes.set(productName, scope); }
      return scope;
    };
    const selection = platformSelection(query.platforms), current = period(scopeFor(query.productName), query, query.from, query.to, query.productName),
      previous = period(scopeFor(query.productName), query, query.compareFrom, query.compareTo, query.productName);
    const currentDays = daysBetween(query.from, query.to), previousDays = daysBetween(query.compareFrom, query.compareTo);
    const comparison = { known: compareTotals(current.knownTotals, previous.knownTotals, currentDays, previousDays),
      complete: compareTotals(current.completeTotals, previous.completeTotals, currentDays, previousDays), byMedium: compareMedia(current, previous),
      previousByMarketplace: previous.byMarketplace,
      currentDays, previousDays, unequalPeriods: currentDays !== previousDays };
    const { coverage: _currentCoverage, ...totals } = current;
    const versionKeys = ["scopePolicyVersion", "nameRuleVersion", "saleUnitRuleVersion", "allocationRuleVersion", "calculationVersion", "fxVersion"] as const;
    const publicVersions = (value: unknown) => Object.fromEntries(versionKeys.map(key => [key, typeof (value as Record<string, unknown>)?.[key] === "string" ? (value as Record<string, string>)[key] : null]));
    const pinnedVersions = Object.fromEntries(versionKeys.map(key => {
      const values = [...new Set(snapshot.publications.map(p => publicVersions(p.run.versions)[key]).filter(Boolean))];
      return [key, !values.length ? null : values.length === 1 ? values[0] : "MIXED"];
    }));
    const configurationChanged = snapshot.publications.some(p => {
      const versions = publicVersions(p.run.versions);
      return (["scopePolicyVersion", "nameRuleVersion", "saleUnitRuleVersion", "allocationRuleVersion"] as const).some(key => versions[key] !== snapshot.versions[key]);
    });
    const partitionKey = (platform: string, scope: string, date: string) => JSON.stringify([platform, scope, date]);
    const sourceTimes = new Map<string, { sourceAsOf: string | null; stale: boolean }>();
    for (const c of snapshot.coverage) {
      const key = partitionKey(c.platform, c.scopeKey, c.date), previous = sourceTimes.get(key);
      sourceTimes.set(key, { sourceAsOf: c.sourceAsOf && (!previous?.sourceAsOf || Date.parse(c.sourceAsOf) < Date.parse(previous.sourceAsOf)) ? c.sourceAsOf : previous?.sourceAsOf ?? null,
        stale: c.collectionState === "STALE" || previous?.stale === true });
    }
    const envelope = { contractVersion: CONTRACT_VERSION,
      selection: { selectedPlatforms: selection.selectedPlatforms, excludedPlatforms: selection.excludedPlatforms,
        scopeKeys: [...new Set(snapshot.scopes.map(s => s.scopeKey))].sort(), productName: query.productName ?? null,
        from: query.from, to: query.to, compareFrom: query.compareFrom, compareTo: query.compareTo, grain: query.grain, selectionHash: query.selectionHash },
      selectedPlatforms: selection.selectedPlatforms, excludedPlatforms: selection.excludedPlatforms,
      excludedByUser: selection.excludedPlatforms.map(platform => ({ platform, participation: "EXCLUDED_BY_USER" })),
      scopeLabel: selection.scopeLabel, profitLabel: metricAvailability(current.coverage, query.platforms.length).state === "SALE_ONLY" ? "선택 범위 광고 전 이익" : selection.profitLabel,
      metricAvailability: metricAvailability(current.coverage, query.platforms.length),
      versions: pinnedVersions, latestConfigurationVersions: snapshot.versions, requestedCalculationVersion: REPORT_CALCULATION_VERSION,
      publishedVersions: snapshot.publications.map(p => ({ runId: p.runId, platform: p.platform, scopeKey: p.scopeKey, date: date(p.businessDate), versions: publicVersions(p.run.versions) })),
      publishedRunIdsBySource: snapshot.publications.map(p => ({ sourceSystem: p.sourceSystem, platform: p.platform, scopeKey: p.scopeKey, date: date(p.businessDate), runId: p.runId, revision: p.revision })),
      asOfBySource: snapshot.publications.map(p => ({ platform: p.platform, scopeKey: p.scopeKey, date: date(p.businessDate),
        publishedAt: p.run.publishedAt?.toISOString() ?? null, ...(sourceTimes.get(partitionKey(p.platform, p.scopeKey, date(p.businessDate))) ?? { sourceAsOf: null, stale: false }) })),
      snapshotHash: snapshot.snapshotHash, ...totals, comparison,
      coverage: safeCoverage(current.coverage), comparisonCoverage: safeCoverage(previous.coverage),
      warnings: safeIssues([...current.issues, ...previous.issues, ...(configurationChanged ? ["CONFIGURATION_CHANGED_REBUILD_RECOMMENDED"] : [])]),
      provisional: query.to >= new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10) };
    if (analysisSettings && lookbackFrom) {
      const scope = scopeFor(query.productName);
      const analysis = calculateRelationships(relationshipDays(scope, query, analysisSettings, lookbackFrom), { from: query.from, to: query.to, changeDate: analysisSettings.changeDate });
      const allSales = ["CAFE24", "COUPANG", "NAVER"].every(p => query.platforms.includes(p as typeof query.platforms[number])) && query.scopeKeys === undefined;
      return { ...envelope, baseSnapshotHash: snapshot.baseSnapshotHash, analysis: { ...analysis, ...analysisSettings, lookbackFrom,
        outcomeLabel: query.productName && allSales ? "제품 전체 매출" : "선택 판매처 합산 매출",
        events: { status: "UNAVAILABLE", message: "가격·행사·품절 이벤트 기록은 연결되지 않았습니다. 요일과 나머지 매체 광고비를 함께 확인하세요." },
        interpretation: "광고비 증가 기간에 매출이 증가하는 등 관측된 동반 변화를 확인합니다. 인과효과나 효과 발생일을 뜻하지 않습니다. 순이익은 광고비를 직접 차감하므로 분석 결과값에서 제외합니다." } };
    }
    const productNames = [...new Set([...snapshot.products.map(p => p.canonicalName), ...snapshot.facts.map(f => f.productName).filter((name): name is string => name !== null)])].sort();
    if (kind === "options") return { ...envelope, products: productNames.map(productName => ({ productName, active: snapshot.products.find(p => p.canonicalName === productName)?.active ?? false,
      historical: !snapshot.products.some(p => p.canonicalName === productName) })),
      platformOptions: PLATFORMS.map(key => ({ key, components: PLATFORM_COMPONENTS[key], defaultIncluded: true,
        available: snapshot.scopes.some(s => s.platform === key) })), scopes: snapshot.scopes, availableDateRanges: snapshot.availableDateRanges,
      defaultSelection: { platforms: [...PLATFORMS], from: query.from, to: query.to } };
    if (kind === "timeseries") {
      // Validate the cursor and select its page before computing per-bucket totals.
      const buckets = page(reportBuckets(query.from, query.to, query.grain), query, snapshot.snapshotHash, kind);
      const items = buckets.items.map(bucket => {
        const { coverage, ...result } = period(scopeFor(query.productName), query, bucket.bucketFrom, bucket.bucketTo, query.productName);
        return { ...bucket, ...result, coverage: safeCoverage(coverage) };
      });
      return { ...envelope, ...buckets, items };
    }
    if (kind === "diagnostics") {
      const controls = new Map(snapshot.publications.map(p => [partitionKey(p.platform, p.scopeKey, date(p.businessDate)),
        Array.isArray(p.run.controlTotals) ? p.run.controlTotals : []]));
      const rows = current.coverage.filter(c => c.participation === "INCLUDED").map(c => ({ ...safeCoverage([c])[0],
        controlTotals: controls.get(partitionKey(c.platform, c.scopeKey, c.date)) ?? [] }));
      return { ...envelope, ...page(rows, query, snapshot.snapshotHash, kind) };
    }
    const names = query.productName ? [query.productName] : productNames;
    const namesPage = page(names, query, snapshot.snapshotHash, kind);
    const rows = namesPage.items.map(productName => {
      const scope = scopeFor(productName);
      const now = period(scope, query, query.from, query.to, productName), before = period(scope, query, query.compareFrom, query.compareTo, productName);
      return { productName, saleUnits: [...new Set(snapshot.facts.filter(f => f.productName === productName && f.saleUnitName).map(f => f.saleUnitName!))].sort(),
        knownTotals: now.knownTotals, completeTotals: now.completeTotals, productProfitSubtotal: now.productProfitSubtotal,
        metricAvailability: metricAvailability(now.coverage, query.platforms.length),
        byMarketplace: now.byMarketplace, byMedium: now.byMedium, isEstimate: now.isEstimate, quality: safeIssues(now.issues),
        commonExpenseAllocationStatus: now.unallocatedExpenses.some(e => e.amount !== "0.000000") ? "UNALLOCATED" : "COMPLETE",
        comparison: compareTotals(now.knownTotals, before.knownTotals, currentDays, previousDays), mediumComparison: compareMedia(now, before) };
    });
    return { ...envelope, ...namesPage, items: rows };
  }
  async rebuild(input: Record<string, unknown>, actor: Actor) {
    allowed(actor, "operations.run");
    if (input.expectedContractVersion !== CONTRACT_VERSION) throw new ConflictException({ code: "UNIFIED_CONTRACT_CHANGED", message: "집계 계약 버전을 확인해 주세요." });
    let query: ReportQuery;
    let productNames: string[] | undefined;
    try {
      const dates = range(input.from, input.to, 92);
      if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1024) throw new Error("재집계 사유가 필요합니다.");
      if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128)) throw new Error("멱등 키를 확인해 주세요.");
      query = parseReportQuery({ ...dates, platforms: input.platforms, scopeKeys: input.scopeKeys });
      productNames = stringArray(input.productNames, "productNames", 100);
    } catch (error) { throw new BadRequestException({ code: "UNIFIED_REBUILD_INVALID", message: error instanceof Error ? error.message : "재집계 조건을 확인해 주세요." }); }
    const scopes = await this.repository.access(query.platforms, query.scopeKeys, productNames);
    if (!scopes.length) throw new BadRequestException({ code: "UNIFIED_REBUILD_EMPTY", message: "재집계 원천 범위를 선택해 주세요." });
    const partitions = scopes.flatMap(scope => datesIn(query.from, query.to).map(date => ({ platform: scope.platform, scopeKey: scope.scopeKey, date })));
    return { contractVersion: CONTRACT_VERSION, status: "QUEUED", execution: "ASYNC_WORKER", executionScope: "FULL_SOURCE_DAY", requestedProductNames: productNames ?? null,
      ...await this.aggregation.enqueue(partitions, actor.id, input.reason as string, input.idempotencyKey as string | undefined) };
  }
  async job(jobId: string, actor: Actor) {
    allowed(actor, "operations.run");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) throw new BadRequestException("jobId를 확인해 주세요.");
    const job = (await this.aggregation.readJobs([jobId]))[0];
    if (!job) throw new NotFoundException({ code: "UNIFIED_JOB_NOT_FOUND", message: "집계 작업을 찾을 수 없습니다." });
    await this.repository.access([job.platform], [job.scopeKey]);
    return { contractVersion: CONTRACT_VERSION, ...job };
  }
}
