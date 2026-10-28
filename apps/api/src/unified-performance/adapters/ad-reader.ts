import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createSourceReadContext, selectCurrentSourceRows, sourceApiDaysInContext } from "../../common/source-read-policy";
import { UnifiedManagementRepository } from "../management.repository";
import type { AdapterBatch, AdapterRequest } from "../types";
import { AdPlatform, AdRow, adConfiguration, adHash, adPageDate, assertAdScope, day, normalizeAdDay, sum } from "./ad-source";

const MAX_ROWS = 10000;
function bounded<T>(rows: T[]): T[] {
  if (rows.length > MAX_ROWS) throw new Error("AD_SOURCE_DAY_TOO_LARGE");
  return rows;
}

/** Internal caller already authorizes workspace data.read; this reader enforces provider/scope before source reads. */
export async function readAdDay(tx: Prisma.TransactionClient, management: UnifiedManagementRepository,
  request: AdapterRequest, platform: AdPlatform): Promise<AdapterBatch> {
  const date = adPageDate(request, platform), scope = request.scopeKeys[0];
  assertAdScope(scope, platform);
  const legacy = platform === "META" && scope === "LEGACY_UNBOUND";
  const connection = legacy ? null : await tx.sourceConnection.findUnique({ where: { id: scope },
    select: { id: true, provider: true, currencyCode: true, timeZone: true } });
  if (!legacy && connection?.provider !== platform) throw new Error("AD_SCOPE_FORBIDDEN");
  const at = new Date(`${date}T00:00:00.000Z`);
  const kind = platform === "META" ? "META_ADSET" : "GOOGLE_CAMPAIGN";
  const currency = connection?.currencyCode ?? "USD", timeZone = connection?.timeZone ?? "Asia/Seoul";
  const [snapshot, policies, coverageRows, rates] = await Promise.all([
    management.snapshot(tx),
    tx.sourcePolicy.findMany({ where: { dataKind: kind, ...(!legacy ? { connectionId: scope } : {}),
      fromDate: { lte: at }, OR: [{ toDate: null }, { toDate: { gt: at } }] }, take: MAX_ROWS + 1 }),
    legacy ? Promise.resolve([]) : tx.sourceCoverage.findMany({ where: { connectionId: scope, dataKind: kind, metricDate: at }, take: 2 }),
    tx.exchangeRate.findMany({ where: { rateDate: at, baseCurrency: currency, quoteCurrency: "KRW", provider: "KOREA_EXIM" }, take: 2,
      select: { rate: true, sourceDate: true, provider: true, fallbackType: true } })
  ]);
  bounded(policies);
  const configuration = adConfiguration(snapshot, request);
  const context = createSourceReadContext(tx, at, at, policies, coverageRows);
  const feature = process.env.DAILY_SYNC_FEATURE_ENABLED === "true";
  const selectedSource = legacy ? "CSV" : feature ? policies.length === 1 ? policies[0].primarySource : null : "CSV";
  const stored = coverageRows.find(row => row.source === selectedSource) ?? null;
  const sourceIssues: string[] = [...(stored?.warningCodes ?? [])];
  let complete = false, excludedRows = 0;
  let normalizedRows: AdRow[] = [];
  let unverifiedRows = 0, unverifiedFingerprint: string | null = null;
  const legacyFx = new Map<string, { rate: string; sourceDate: string; ruleId: string }>();
  if (platform === "META") {
    const candidates = bounded(await tx.metaAdsetDailyMetric.findMany({ where: { isCurrent: true, connectionId: legacy ? null : scope, metricDate: at },
      select: { id: true, metaAdsetId: true, adsetName: true, connectionId: true, source: true, importVersion: true,
        sourceRevision: true, uploadBatchId: true, syncRunId: true, metricDate: true, spendUsd: true, purchaseValueUsd: true,
        createdAt: true, updatedAt: true }, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }));
    try {
      const rows = await selectCurrentSourceRows(tx, kind, candidates, row => row.metricDate, context);
      // Empty API days require the same intact publish proof as nonzero days.
      const apiDays = feature && !legacy && selectedSource === "API" ? await sourceApiDaysInContext(tx, kind, at, at, context) : new Set<string>();
      complete = selectedSource === "API" ? !!stored?.lastSuccessAt && !!stored.lastSuccessRunId && stored.rowCount === rows.length && apiDays.has(`${scope}:${at.getTime()}`)
        : selectedSource === "CSV" && rows.length > 0;
      normalizedRows = rows.map(row => ({ id: row.id, entityKey: row.metaAdsetId, originalName: row.adsetName, source: row.source,
        sourceVersion: `${row.importVersion}:${row.sourceRevision ?? ""}`, runOrUploadId: row.source === "API" ? row.syncRunId : row.uploadBatchId,
        observedAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), amount: row.spendUsd.toFixed(), conversionRevenue: row.purchaseValueUsd?.toFixed() ?? null }));
      excludedRows = candidates.length - rows.length;
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      sourceIssues.push("SOURCE_SELECTION_REQUIRED");
      excludedRows = candidates.length;
    }
    // Legacy fallback is resolved by the fixed product NAME, never a stale source product FK.
    if (!rates.length) {
      const costs = bounded(await tx.productCostRule.findMany({ where: { effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] },
        select: { id: true, effectiveFrom: true, fxRateKrwPerUsd: true, product: { select: { displayName: true, isActive: true } } }, take: MAX_ROWS + 1 }));
      const byName = new Map<string, typeof costs>();
      for (const cost of costs.filter(cost => cost.product.isActive)) {
        const bucket = byName.get(cost.product.displayName) ?? []; bucket.push(cost); byName.set(cost.product.displayName, bucket);
      }
      for (const [name, candidates] of byName) {
        candidates.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
        const latest = candidates.filter(row => row.effectiveFrom.getTime() === candidates[0].effectiveFrom.getTime());
        if (latest.length === 1 && latest[0].fxRateKrwPerUsd.gt(0)) legacyFx.set(name, {
          rate: latest[0].fxRateKrwPerUsd.toFixed(), sourceDate: day(latest[0].effectiveFrom), ruleId: latest[0].id });
      }
    }
  } else {
    const candidates = bounded(await tx.googleCampaignDailyCost.findMany({ where: { isCurrent: true, connectionId: scope, metricDate: at },
      select: { id: true, campaignId: true, campaignName: true, connectionId: true, source: true, version: true, syncRunId: true,
        metricDate: true, costMicros: true, conversionValue: true, fetchedAt: true }, orderBy: { id: "asc" }, take: MAX_ROWS + 1 }));
    try {
      const rows = await selectCurrentSourceRows(tx, kind, candidates, row => row.metricDate, context);
      excludedRows = candidates.length - rows.length;
      const [links, units] = selectedSource === "API" && stored?.lastSuccessRunId ? await Promise.all([
        rows.length ? tx.sourceRecordLink.findMany({ where: { connectionId: scope, dataKind: kind, source: "API",
          recordTable: "google_campaign_daily_costs", recordId: { in: rows.map(row => row.id) }, isCurrent: true }, take: MAX_ROWS + 1 }) : Promise.resolve([]),
        tx.runUnit.findMany({ where: { runId: stored.lastSuccessRunId, unitKey: date, status: "SUCCEEDED", run: { connectionId: scope } }, take: 2 })
      ]) : [[], []];
      bounded(links);
      complete = selectedSource === "CSV" ? rows.length > 0 : selectedSource === "API" && !!stored?.lastSuccessAt && !!stored.lastSuccessRunId &&
        stored.rowCount === rows.length && stored.totalAmount !== null && links.length === rows.length &&
        rows.every(row => { const match = links.filter(link => link.recordId === row.id); return match.length === 1 && match[0].version === row.version && match[0].syncRunId === row.syncRunId; }) &&
        sum(rows.map(row => row.costMicros.toString())).div(1000000).equals(stored.totalAmount) && units.length === 1 && units[0].publishedCount === rows.length;
      normalizedRows = rows.map(row => ({ id: row.id, entityKey: row.campaignId, originalName: row.campaignName, source: row.source,
        sourceVersion: String(row.version), runOrUploadId: row.syncRunId, observedAt: row.fetchedAt.toISOString(), updatedAt: row.fetchedAt.toISOString(),
        amount: row.costMicros.toString(), conversionRevenue: row.conversionValue?.toFixed() ?? null }));
      // Match the existing report: incomplete lineage cannot establish a usable atomic API snapshot.
      if (selectedSource === "API" && !complete) {
        sourceIssues.push("GOOGLE_CURRENT_LINEAGE_UNVERIFIED");
        unverifiedRows = normalizedRows.length;
        unverifiedFingerprint = adHash(normalizedRows);
        normalizedRows = [];
      }
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      sourceIssues.push("SOURCE_SELECTION_REQUIRED");
      excludedRows = candidates.length;
    }
  }
  if (!selectedSource || legacy && policies.length > 0 && !normalizedRows.length) sourceIssues.push("SOURCE_SELECTION_REQUIRED");
  const rate = rates.length === 1 ? rates[0] : null;
  return normalizeAdDay(request, { platform, date, scopeKey: scope, currency, timeZone, rows: normalizedRows, selectedSource, complete,
    sourceIssues, storedCoverage: stored, fx: rate ? { rate: rate.rate.toFixed(), sourceDate: day(rate.sourceDate), provider: rate.provider, fallbackType: rate.fallbackType } : null,
    legacyFx, excludedRows, configuration, unverifiedRows, sourceSelectionEvidence: { feature, unverifiedFingerprint, policies: policies.map(policy => [policy.connectionId,
      policy.dataKind, policy.fromDate.toISOString(), policy.toDate?.toISOString() ?? null, policy.primarySource]),
      coverage: stored ? [stored.lastSuccessRunId, stored.lastSuccessAt?.toISOString(), stored.rowCount, stored.totalAmount?.toFixed(), stored.warningCodes] : null } });
}
