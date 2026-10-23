import { beginMetaDayBatch } from "./meta-day-batch";
import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import {
  AdStage, MatchSource, MetaAdDailyMetric, MetaAdsetDailyMetric, Prisma,
  RowValidationStatus, SourceDataKind, SourceKind
} from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { selectCurrentSourceRows } from "../common/source-read-policy";
import { normalizeProductNo } from "../domain/cafe24-matcher";
import { CreativeNameParser, CreativeNameParts } from "../domain/creative-name-parser";
import { assertNoUnboundCurrentRows } from "./canonical-write-policy";
import { AdsetNameNormalizer } from "../domain/adset-name-normalizer";
import { formatDateOnly } from "../domain/date-number";
import { MappingsService } from "../mappings/mappings.service";
import { MetaEntityWriterService } from "../uploads/meta-entity-writer.service";
import { MetaMetricVersionService } from "../uploads/meta-metric-version.service";
import { minDate, maxDate } from "../uploads/upload-keys";
import { SyncFoundationService } from "./sync-foundation.service";
import { syncError } from "./sync-contract";
import { Cafe24CanonicalWriterService } from "./cafe24-canonical-writer.service";
import type { Cafe24ApiOrder } from "./cafe24-api-order";
import { META_UNAVAILABLE_REASONS, MetaUnavailableReasons } from "../domain/meta-conditional-metrics";
import { cafe24OptionCompositionFits } from "./cafe24-option-projection";
import { MetaCurrentMetadata, currentDeliveryStatus, stableMetadataJson, validCurrentMetadata, MetaMcpNullBasicProjection, validNullBasicProjection } from "../domain/meta-current-metadata";
import { assertMetaOperatingGate } from "./meta-operating-gate";

/** Values are already normalized by a provider adapter. No upload or CSV objects enter this interface. */
export type MetaApiAd = {
  campaignId: string; campaignName: string; adsetId: string; adsetName: string;
  adId: string; adName: string; creative: CreativeNameParts; sourceRevision: string;
  spendUsd: string; impressions: string; inlineLinkClicks: number;
  purchaseCount: number | null; resultCount: number | null; reach: number; attributionSetting: string | null;
  purchaseValueUsd?:string|null;
  actionReportTime: string;
  attributionWindows: string[]; metricUnavailableReasons: MetaUnavailableReasons;
  currentMetadata?: MetaCurrentMetadata | null; metadataObservedAt?: Date | null;
  deliveryStatus?: string | null; resultIndicator?: string | null;
  videoPlay3sCount?: number | null; videoPlay25Count?: number | null;
  videoPlay50Count?: number | null; videoPlay75Count?: number | null;
  videoPlay100Count?: number | null; addToCartCount?: number | null;
  frequency?: string | null; costPerResultUsd?: string | null;
  adsetBudgetLabel?: string | null; adsetBudgetType?: string | null;
  endStatus?: string | null; qualityRanking?: string | null;
  engagementRateRanking?: string | null; conversionRateRanking?: string | null;
  cpmUsd?: string | null; shopClicks: number | null; cpcLinkUsd?: string | null;
  ctrLinkPct?: string | null; clicksAll: number; ctrAllPct?: string | null;
  cpcAllUsd?: string | null; landingPageViews: number | null;
  costPerLandingPageViewUsd?: string | null;
};

export type MetaApiAdset = {
  campaignId: string; campaignName: string; adsetId: string; adsetName: string;
  sourceRevision: string; spendUsd: string; impressions: string; inlineLinkClicks: number;
  resultCount: number | null; reach: number; attributionSetting: string | null;
  purchaseCount?:number|null;purchaseValueUsd?:string|null;
  actionReportTime: string;
  attributionWindows: string[]; metricUnavailableReasons: MetaUnavailableReasons;
  currentMetadata?: MetaCurrentMetadata | null; metadataObservedAt?: Date | null;
  deliveryStatus?: string | null; resultIndicator?: string | null;
  frequency?: string | null; costPerResultUsd?: string | null;
  adsetBudgetLabel?: string | null; adsetBudgetType?: string | null;
  endStatus?: string | null; startDate?: Date | null;
  cpmUsd?: string | null; shopClicks: number | null; cpcLinkUsd?: string | null;
  ctrLinkPct?: string | null; clicksAll: number; ctrAllPct?: string | null;
  cpcAllUsd?: string | null; landingPageViews: number | null;
  costPerLandingPageViewUsd?: string | null;
};

export type { Cafe24ApiOrder } from "./cafe24-api-order";

type PublishHeader = {
  connectionId: string; runId: string; generation: bigint; metricDate: Date;
  pageCount: number; policyVersion: number; checkpointValue?: string | null;
};

@Injectable()
export class CanonicalApiWriterService {
  private readonly creativeNameParser = new CreativeNameParser();
  private readonly cafe24Writer: Cafe24CanonicalWriterService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly foundation: SyncFoundationService,
    private readonly mappings: MappingsService,
    private readonly entities: MetaEntityWriterService,
    private readonly versions: MetaMetricVersionService
  ) { this.cafe24Writer = new Cafe24CanonicalWriterService(prisma, foundation); }

  async publishMetaDay(input: Omit<PublishHeader, "policyVersion"> & {
    adPolicyVersion: number; adsetPolicyVersion: number;
    expectedCredentialRef: string; expectedCredentialExpiresAt: Date;
    expectedMetaTransport?: "GRAPH" | "MCP";nullBasicParentProjection?:MetaMcpNullBasicProjection;
    ads: MetaApiAd[]; adsets: MetaApiAdset[];
  }) {
    const day = validDay(input.metricDate);
    if(input.nullBasicParentProjection&&(!validNullBasicProjection(input.nullBasicParentProjection)||input.expectedMetaTransport!=="MCP"||input.nullBasicParentProjection.selectedAdCount!==input.ads.length||[...input.ads,...input.adsets].some(row=>stableMetadataJson(row.currentMetadata?.sourceContext?.measurementEvidence?.nullBasicParentProjection)!==stableMetadataJson(input.nullBasicParentProjection))))syncError("RECONCILIATION_FAILED");
    if(!input.nullBasicParentProjection&&[...input.ads,...input.adsets].some(row=>row.currentMetadata?.sourceContext?.measurementEvidence?.nullBasicParentProjection))syncError("RECONCILIATION_FAILED");
    if ([...input.ads, ...input.adsets].some(row => row.actionReportTime === "MCP_PROVIDER_DEFAULT_UNVERIFIED") && input.expectedMetaTransport !== "MCP")
      syncError("PROVIDER_AUTH_REQUIRED");
    if (input.expectedMetaTransport) assertMetaOperatingGate(input.expectedMetaTransport);
    if (input.expectedMetaTransport === "MCP" && [...input.ads, ...input.adsets].some(row => row.actionReportTime !== "MCP_PROVIDER_DEFAULT_UNVERIFIED"))
      syncError("ATTRIBUTION_MISMATCH");
    if(input.expectedMetaTransport==="MCP"&&[...input.ads,...input.adsets].some(row=>!row.currentMetadata?.sourceContext?.purchaseMeasurement||row.purchaseCount==null||row.purchaseValueUsd==null))
      syncError("FIELD_UNSUPPORTED");
    const adKeys = new Set<string>();
    const adsetKeys = new Set<string>();
    const reportingTimes = new Set<string>();
    for (const row of input.ads) {
      requiredId(row.campaignId); requiredId(row.adsetId); requiredId(row.adId); requiredId(row.sourceRevision);
      requiredName(row.campaignName); requiredName(row.adsetName); requiredName(row.adName);
      if (!sameCreativeParts(this.creativeNameParser.parse(row.adName), row.creative))
        invalid("Meta creative fields do not match the canonical ad-name parser.");
      const key = businessKey(input.connectionId, day, row.campaignId, row.adsetId, row.adId);
      if (adKeys.has(key)) invalid("Duplicate Meta ad business key in a complete API day.");
      adKeys.add(key);
      metaMeasures(row, true);
      requiredActionReportTime(row.actionReportTime);
      reportingTimes.add(row.actionReportTime.trim());
    }
    for (const row of input.adsets) {
      requiredId(row.campaignId); requiredId(row.adsetId); requiredId(row.sourceRevision);
      requiredName(row.campaignName); requiredName(row.adsetName);
      const key = businessKey(input.connectionId, day, row.adsetId);
      if (adsetKeys.has(key)) invalid("Duplicate Meta adset business key in a complete API day.");
      adsetKeys.add(key);
      metaMeasures(row, false);
      requiredActionReportTime(row.actionReportTime);
      reportingTimes.add(row.actionReportTime.trim());
    }
    if (reportingTimes.size > 1) invalid("Meta action reporting times differ within the API day.");
    if (input.ads.some((row) => !adsetKeys.has(businessKey(input.connectionId, day, row.adsetId))))
      invalid("Meta ad has no matching adset in the complete API day.");
    const adsetById = new Map(input.adsets.map((row) => [row.adsetId, row]));
    if (input.ads.some((row) => adsetById.get(row.adsetId)?.campaignId !== row.campaignId))
      invalid("Meta ad and adset campaign identities differ in the complete API day.");
    const spendByAdset = new Map<string, Prisma.Decimal>();
    for (const row of input.ads) spendByAdset.set(row.adsetId,
      (spendByAdset.get(row.adsetId) ?? new Prisma.Decimal(0)).plus(row.spendUsd));
    if (input.adsets.some((row) =>
      !(spendByAdset.get(row.adsetId) ?? new Prisma.Decimal(0)).eq(row.spendUsd)))
      invalid("Meta ad and adset spend totals differ for a complete API day.");
    const adSpend = input.ads.reduce((sum, row) => sum.plus(row.spendUsd), new Prisma.Decimal(0));
    const adsetSpend = input.adsets.reduce((sum, row) => sum.plus(row.spendUsd), new Prisma.Decimal(0));
    if (!adSpend.eq(adsetSpend)) invalid("Meta ad and adset spend totals differ for a complete API day.");
    const purchaseEvidence=input.ads[0]?.currentMetadata?.sourceContext?.purchaseMeasurement;
    if([...input.ads,...input.adsets].some(r=>r.currentMetadata?.sourceContext?.purchaseMeasurement)){
      if(!purchaseEvidence||[...input.ads,...input.adsets].some(r=>stableMetadataJson(r.currentMetadata?.sourceContext?.purchaseMeasurement)!==stableMetadataJson(purchaseEvidence)))invalid("Provider purchase evidence differs within the API day.");
      if(input.ads.reduce((s,r)=>s+r.purchaseCount!,0)!==purchaseEvidence.accountPurchaseCount||input.adsets.reduce((s,r)=>s+r.purchaseCount!,0)!==purchaseEvidence.accountPurchaseCount||
        !input.ads.reduce((s,r)=>s.plus(r.purchaseValueUsd!),new Prisma.Decimal(0)).eq(purchaseEvidence.adPurchaseValueUsd)||
        !input.adsets.reduce((s,r)=>s.plus(r.purchaseValueUsd!),new Prisma.Decimal(0)).eq(purchaseEvidence.selectedAdsetPurchaseValueUsd)||
        input.ads.filter(r=>r.currentMetadata?.sourceContext?.rawPurchaseNull===true).length!==purchaseEvidence.derivedZeroAdCount)invalid("Provider purchase rows differ from their complete-day evidence.");
      for(const parent of input.adsets)if(input.ads.filter(r=>r.adsetId===parent.adsetId).reduce((s,r)=>s+r.purchaseCount!,0)!==parent.purchaseCount)invalid("Provider purchase parent count does not reconcile.");
    }
    return this.foundation.publishUnit({
      runId: input.runId, generation: input.generation, unitKey: day,
      metricDate: input.metricDate, checkpointValue: input.checkpointValue,
      slices: [
        { dataKind: SourceDataKind.META_AD, source: SourceKind.API, policyVersion: input.adPolicyVersion,
          fetchedCount: input.ads.length, pageCount: input.pageCount, complete: true, totalAmount: adSpend },
        { dataKind: SourceDataKind.META_ADSET, source: SourceKind.API, policyVersion: input.adsetPolicyVersion,
          fetchedCount: input.adsets.length, pageCount: input.pageCount, complete: true, totalAmount: adsetSpend }
      ],
      writeRows: async (rawTx) => {
        let tx=rawTx;
        if (input.expectedMetaTransport) assertMetaOperatingGate(input.expectedMetaTransport);
        await assertPublishScope(tx, input.runId, input.connectionId, "META", "USD");
        const binding = await tx.sourceConnection.findUnique({ where: { id: input.connectionId },
          select: { credentialRef: true, credentialExpiresAt: true } });
        if (binding?.credentialRef !== input.expectedCredentialRef ||
            binding.credentialExpiresAt?.getTime() !== input.expectedCredentialExpiresAt.getTime() ||
            input.expectedCredentialExpiresAt.getTime() <= Date.now() + 7 * 86_400_000)
          syncError("PROVIDER_AUTH_REQUIRED");
        await assertNoUnboundCurrentRows(tx, SourceDataKind.META_AD, [input.metricDate]);
        await assertNoUnboundCurrentRows(tx, SourceDataKind.META_ADSET, [input.metricDate]);
        const batch=await beginMetaDayBatch(rawTx,{connectionId:input.connectionId,metricDate:input.metricDate,ads:input.ads,adsets:input.adsets});
        tx=batch.client;
        const touchedAdsetIds = new Set<string>();
        const currentAds = await tx.metaAdDailyMetric.findMany({ where: {
          connectionId: input.connectionId, source: SourceKind.API, metricDate: input.metricDate, isCurrent: true
        }, select: { id: true, metaCampaignId: true, metaAdsetId: true,
          metaAdsetRefId: true, adIdentityKey: true } });
        for (const row of currentAds) touchedAdsetIds.add(row.metaAdsetRefId);
        const staleAds = currentAds.filter((row) => !adKeys.has(businessKey(input.connectionId, day,
          row.metaCampaignId, row.metaAdsetId, row.adIdentityKey))).map((row) => row.id);
        if (input.nullBasicParentProjection && staleAds.length) syncError("RECONCILIATION_FAILED");
        if (staleAds.length) await demoteMetricAndLinks(tx, "meta_ad_daily_metrics", staleAds, "ad");

        for (const row of input.ads) {
          const creative = await this.entities.upsertCreativeParts(row.creative, input.metricDate, tx);
          const refs = await this.entities.upsertApiEntities({
            connectionId: input.connectionId, metricDate: input.metricDate,
            campaignId: row.campaignId, campaignName: row.campaignName,
            adsetId: row.adsetId, adsetName: row.adsetName, adId: row.adId, adName: row.adName,
            creativeId: creative.id
          }, tx);
          touchedAdsetIds.add(refs.adset.id);
          await this.entities.upsertCreativeAlias(creative.id, row.creative, input.metricDate, tx);
          await this.entities.upsertCreativePlacementRecord({
            connectionId: input.connectionId, creativeId: creative.id,
            campaignRefId: refs.campaign.id, metaAdsetRefId: refs.adset.id,
            metaAdRefId: refs.ad.id, metaCampaignId: row.campaignId,
            metaAdsetId: row.adsetId, originalAdName: row.creative.originalName,
            campaignName: row.campaignName, adsetName: row.adsetName,
            setting: row.creative.setting, metricDate: input.metricDate,
            lastStatus: row.deliveryStatus ?? null
          }, tx);
          const match = await this.matchMeta(refs.adset.id,
            `${row.adName} ${row.adsetName} ${row.campaignName}`,
            `${row.campaignName} ${row.adsetName}`, input.metricDate, tx);
          const result = await this.versions.importApiAdDailyMetric({
            connectionId: input.connectionId, revision: row.sourceRevision,
            data: {
              campaignRefId: refs.campaign.id, metaAdsetRefId: refs.adset.id,
              metaAdRefId: refs.ad.id, creativeId: creative.id,
              metricDate: input.metricDate, dateStart: input.metricDate, dateEnd: input.metricDate,
              metaCampaignId: row.campaignId, campaignNameSnapshot: row.campaignName,
              metaAdsetId: row.adsetId, adsetNameSnapshot: row.adsetName,
              metaAdId: row.adId, syntheticAdKey: row.adId, adIdentityKey: row.adId,
              adNameSnapshot: row.adName, adDeliveryStatus: row.deliveryStatus ?? null,
              attributionSetting: row.attributionSetting,
              attributionWindows: row.attributionWindows,
              metricUnavailableReasons: row.metricUnavailableReasons,
              currentMetadata: row.currentMetadata ?? Prisma.DbNull,
              metadataObservedAt: row.metadataObservedAt ?? null,
              actionReportTime: row.actionReportTime.trim(),
              resultIndicator: row.resultIndicator ?? null,
              resultCount: row.resultCount, purchaseCount: row.purchaseCount, reach: row.reach,
              purchaseValueUsd:optionalMetaDecimal(row.purchaseValueUsd,14,4),
              videoPlay3sCount: row.videoPlay3sCount ?? null,
              videoPlay25Count: row.videoPlay25Count ?? null,
              videoPlay50Count: row.videoPlay50Count ?? null,
              videoPlay75Count: row.videoPlay75Count ?? null,
              videoPlay100Count: row.videoPlay100Count ?? null,
              addToCartCount: row.addToCartCount ?? null,
              frequency: optionalMetaDecimal(row.frequency, 12, 6),
              costPerResultUsd: optionalMetaDecimal(row.costPerResultUsd, 14, 4),
              adsetBudgetLabel: row.adsetBudgetLabel ?? null,
              adsetBudgetType: row.adsetBudgetType ?? null,
              spendUsd: new Prisma.Decimal(row.spendUsd), impressions: BigInt(row.impressions),
              endStatus: row.endStatus ?? null, qualityRanking: row.qualityRanking ?? null,
              engagementRateRanking: row.engagementRateRanking ?? null,
              conversionRateRanking: row.conversionRateRanking ?? null,
              cpmUsd: optionalMetaDecimal(row.cpmUsd, 14, 4),
              linkClicks: row.inlineLinkClicks, shopClicks: row.shopClicks,
              cpcLinkUsd: optionalMetaDecimal(row.cpcLinkUsd, 14, 4),
              ctrLinkPct: optionalMetaDecimal(row.ctrLinkPct, 10, 6),
              clicksAll: row.clicksAll,
              ctrAllPct: optionalMetaDecimal(row.ctrAllPct, 10, 6),
              cpcAllUsd: optionalMetaDecimal(row.cpcAllUsd, 14, 4),
              landingPageViews: row.landingPageViews,
              costPerLandingPageViewUsd: optionalMetaDecimal(row.costPerLandingPageViewUsd, 14, 4),
              productId: match.productId, productMatchSource: match.productSource,
              productMatchRuleId: match.productRuleId, stage: match.stage,
              stageMatchSource: match.stageSource, syncRunId: input.runId
            }
          }, tx);
          if (result.imported) {
            await linkApiRow(tx, input, SourceDataKind.META_AD,
              businessKey(input.connectionId, day, row.campaignId, row.adsetId, row.adId),
              "meta_ad_daily_metrics", result.metric.id, result.metric.importVersion);
          } else {
            const stored = await tx.metaAdDailyMetric.findUnique({ where: { id: result.metric.id } });
            if (!stored || !sameMetaAd(stored, row, creative.id))
              invalid("Meta ad revision was reused with changed normalized content.");
            if (row.metadataObservedAt) await tx.metaAdDailyMetric.update({ where: { id: stored.id },
              data: { metadataObservedAt: row.metadataObservedAt } });
          }
        }

        const currentAdsets = await tx.metaAdsetDailyMetric.findMany({ where: {
          connectionId: input.connectionId, source: SourceKind.API, metricDate: input.metricDate, isCurrent: true
        }, select: { id: true, metaAdsetId: true,
          metaAdset: { select: { externalAdsetId: true } } } });
        for (const row of currentAdsets) touchedAdsetIds.add(row.metaAdsetId);
        const staleAdsets = currentAdsets.filter((row) => !row.metaAdset.externalAdsetId ||
          !adsetKeys.has(businessKey(input.connectionId, day, row.metaAdset.externalAdsetId)))
          .map((row) => row.id);
        if (input.nullBasicParentProjection && staleAdsets.length) syncError("RECONCILIATION_FAILED");
        if (staleAdsets.length) await demoteMetricAndLinks(tx, "meta_adset_daily_metrics", staleAdsets, "adset");
        for (const row of input.adsets) {
          const refs = await this.upsertApiAdset(row, input.connectionId, input.metricDate, tx);
          touchedAdsetIds.add(refs.adsetId);
          const match = await this.matchMeta(refs.adsetId, row.adsetName,
            row.adsetName, input.metricDate, tx);
          const result = await this.versions.importApiAdsetMetric({
            connectionId: input.connectionId, revision: row.sourceRevision,
            data: {
              metaAdsetId: refs.adsetId, metricDate: input.metricDate,
              dateStart: input.metricDate, dateEnd: input.metricDate,
              adsetName: row.adsetName, adsetNameKey: AdsetNameNormalizer.toKey(row.adsetName),
              deliveryStatus: row.deliveryStatus ?? null,
              attributionSetting: row.attributionSetting,
              attributionWindows: row.attributionWindows,
              metricUnavailableReasons: row.metricUnavailableReasons,
              currentMetadata: row.currentMetadata ?? Prisma.DbNull,
              metadataObservedAt: row.metadataObservedAt ?? null,
              actionReportTime: row.actionReportTime.trim(),
              resultIndicator: row.resultIndicator ?? null, resultCount: row.resultCount,
              purchaseCount:row.purchaseCount??null,purchaseValueUsd:optionalMetaDecimal(row.purchaseValueUsd,14,4),
              reach: row.reach, frequency: optionalMetaDecimal(row.frequency, 12, 6),
              costPerResultUsd: optionalMetaDecimal(row.costPerResultUsd, 14, 4),
              adsetBudgetLabel: row.adsetBudgetLabel ?? null,
              adsetBudgetType: row.adsetBudgetType ?? null,
              spendUsd: new Prisma.Decimal(row.spendUsd), impressions: BigInt(row.impressions),
              endStatus: row.endStatus ?? null, startDate: row.startDate ?? null,
              cpmUsd: optionalMetaDecimal(row.cpmUsd, 14, 4),
              linkClicks: row.inlineLinkClicks, shopClicks: row.shopClicks,
              cpcLinkUsd: optionalMetaDecimal(row.cpcLinkUsd, 14, 4),
              ctrLinkPct: optionalMetaDecimal(row.ctrLinkPct, 10, 6),
              clicksAll: row.clicksAll,
              ctrAllPct: optionalMetaDecimal(row.ctrAllPct, 10, 6),
              cpcAllUsd: optionalMetaDecimal(row.cpcAllUsd, 14, 4),
              landingPageViews: row.landingPageViews,
              costPerLandingPageViewUsd: optionalMetaDecimal(row.costPerLandingPageViewUsd, 14, 4),
              productId: match.productId, productMatchSource: match.productSource,
              productMatchRuleId: match.productRuleId, stage: match.stage,
              stageMatchSource: match.stageSource, syncRunId: input.runId
            }
          }, tx);
          if (result.imported) {
            await linkApiRow(tx, input, SourceDataKind.META_ADSET,
              businessKey(input.connectionId, day, row.adsetId),
              "meta_adset_daily_metrics", result.metric.id, result.metric.importVersion);
          } else {
            const stored = await tx.metaAdsetDailyMetric.findUnique({ where: { id: result.metric.id } });
            if (!stored || !sameMetaAdset(stored, row))
              invalid("Meta adset revision was reused with changed normalized content.");
            if (row.metadataObservedAt) await tx.metaAdsetDailyMetric.update({ where: { id: stored.id },
              data: { metadataObservedAt: row.metadataObservedAt } });
          }
        }
        await this.refreshMetaAdsetPointers(tx, [...touchedAdsetIds],
          { connectionId: input.connectionId, metricDate: input.metricDate });
        if (input.expectedMetaTransport) assertMetaOperatingGate(input.expectedMetaTransport);
        await batch.flush();
        return { META_AD: input.ads.length, META_ADSET: input.adsets.length };
      }
    });
  }

  /** Retained public facade for callers that also publish Meta rows. */
  async publishCafe24Day(input: PublishHeader & {
    completeDaySnapshot: true; fetchedAt: Date; orders: Cafe24ApiOrder[];
  }) { return this.cafe24Writer.publishCafe24Day(input); }

  async publishCafe24ChangedWindow(input: Omit<PublishHeader, "metricDate" | "policyVersion"> & {
    windowDate: Date; windowStart: Date; windowEnd: Date; orders: Cafe24ApiOrder[];
    policyVersionsByOrderDate: Record<string, number>;
  }): Promise<never> { return this.cafe24Writer.publishCafe24ChangedWindow(input); }

  private async matchMeta(adsetId: string, productText: string, stageText: string,
    date: Date, tx: Prisma.TransactionClient) {
    const product = await this.mappings.matchProduct(adsetId, productText, date, tx);
    const stage = await this.mappings.matchStage(adsetId, stageText, date, tx);
    return { productId: product.productId, productSource: product.source as MatchSource,
      productRuleId: product.matchRuleId, stage: stage.stage as AdStage,
      stageSource: stage.source as MatchSource };
  }

  private async refreshMetaAdsetPointers(tx: Prisma.TransactionClient, adsetIds: string[],
    prepared?: { connectionId: string; metricDate: Date }) {
    if (!adsetIds.length) return;
    const candidates = await tx.metaAdsetDailyMetric.findMany({
      where: { metaAdsetId: { in: adsetIds }, isCurrent: true },
      orderBy: [{ metricDate: "desc" }, { id: "desc" }],
      select: { metaAdsetId: true, metricDate: true, source: true, connectionId: true, productId: true, stage: true }
    });
    // Validate all historical account/day groups once. The prepared exception is
    // still confined to this fenced transaction's exact connection and date.
    const isPrepared = (row: typeof candidates[number]) => prepared !== undefined &&
      row.connectionId === prepared.connectionId && row.metricDate.getTime() === prepared.metricDate.getTime();
    const visible = await selectCurrentSourceRows(tx, SourceDataKind.META_ADSET,
      candidates.filter((row) => !isPrepared(row)), (metric) => metric.metricDate);
    const selected = [...visible, ...candidates.filter((row) => isPrepared(row) && row.source === SourceKind.API)];
    const byAdset = new Map<string, typeof selected>();
    for (const row of selected) {
      const rows = byAdset.get(row.metaAdsetId) ?? []; rows.push(row); byAdset.set(row.metaAdsetId, rows);
    }
    for (const adsetId of adsetIds) {
      const latest = (byAdset.get(adsetId) ?? []).sort((a, b) => b.metricDate.getTime() - a.metricDate.getTime())[0];
      await tx.metaAdset.update({ where: { id: adsetId }, data: {
        currentProductId: latest?.productId ?? null, currentStage: latest?.stage ?? AdStage.UNKNOWN
      } });
    }
  }

  private async upsertApiAdset(row: MetaApiAdset, connectionId: string,
    metricDate: Date, tx: Prisma.TransactionClient) {
    const campaignWhere = { connectionId, platform: "META", externalCampaignId: row.campaignId };
    const campaign = await tx.metaCampaign.findFirst({ where: campaignWhere });
    const campaignRecord = campaign
      ? await tx.metaCampaign.update({ where: { id: campaign.id }, data: {
          ...(!campaign.lastSeenOn || metricDate >= campaign.lastSeenOn
            ? { campaignName: row.campaignName } : {}),
          firstSeenOn: minDate(campaign.firstSeenOn, metricDate),
          lastSeenOn: maxDate(campaign.lastSeenOn, metricDate) } })
      : await tx.metaCampaign.create({ data: { ...campaignWhere,
          campaignName: row.campaignName, firstSeenOn: metricDate, lastSeenOn: metricDate } });
    const adset = await tx.metaAdset.findFirst({ where: {
      connectionId, platform: "META", externalAdsetId: row.adsetId
    } });
    const adsetRecord = adset
      ? await tx.metaAdset.update({ where: { id: adset.id }, data: {
          ...(!adset.lastSeenOn || metricDate >= adset.lastSeenOn
            ? { campaignRefId: campaignRecord.id, adsetName: row.adsetName,
                adsetNameKey: AdsetNameNormalizer.toKey(row.adsetName) } : {}),
          firstSeenOn: minDate(adset.firstSeenOn, metricDate),
          lastSeenOn: maxDate(adset.lastSeenOn, metricDate) } })
      : await tx.metaAdset.create({ data: {
          connectionId, platform: "META", externalAdsetId: row.adsetId,
          campaignRefId: campaignRecord.id, adsetName: row.adsetName,
          adsetNameKey: AdsetNameNormalizer.toKey(row.adsetName),
          firstSeenOn: metricDate, lastSeenOn: metricDate
        } });
    return { adsetId: adsetRecord.id };
  }


}

async function assertPublishScope(tx: Prisma.TransactionClient, runId: string, connectionId: string,
  provider: "META" | "CAFE24", currencyCode: "USD" | "KRW") {
  const run = await tx.syncRun.findUnique({ where: { id: runId }, select: { connectionId: true } });
  if (run?.connectionId !== connectionId) invalid("Run and connection do not match.");
  const connection = await tx.sourceConnection.findUnique({ where: { id: connectionId },
    select: { provider: true, currencyCode: true, timeZone: true } });
  if (connection?.provider !== provider || connection.currencyCode !== currencyCode ||
      connection.timeZone !== "Asia/Seoul") invalid("Provider currency/timezone scope does not match canonical input.");
}

async function linkApiRow(tx: Prisma.TransactionClient, input: Pick<PublishHeader, "connectionId" | "runId">,
  dataKind: SourceDataKind, key: string, recordTable: string, recordId: string, version: number) {
  const canonicalKeyHash = sha256(key);
  await tx.sourceRecordLink.updateMany({ where: {
    connectionId: input.connectionId, dataKind, source: SourceKind.API,
    canonicalKeyHash, recordTable, isCurrent: true
  }, data: { isCurrent: false } });
  await tx.sourceRecordLink.create({ data: {
    connectionId: input.connectionId, dataKind, canonicalKeyHash, source: SourceKind.API,
    recordTable, recordId, syncRunId: input.runId, version, isCurrent: true,
    bindingMethod: "EXACT_ID"
  } });
}

async function demoteMetricAndLinks(tx: Prisma.TransactionClient, recordTable: string,
  ids: string[], kind: "ad" | "adset") {
  if (kind === "ad") await tx.metaAdDailyMetric.updateMany({ where: { id: { in: ids } }, data: { isCurrent: false } });
  else await tx.metaAdsetDailyMetric.updateMany({ where: { id: { in: ids } }, data: { isCurrent: false } });
  await tx.sourceRecordLink.updateMany({ where: {
    recordTable, recordId: { in: ids }, source: SourceKind.API, isCurrent: true
  }, data: { isCurrent: false } });
}

function businessKey(...parts: string[]) { return JSON.stringify(parts.map((part) => part.trim())); }
function cafe24Key(connectionId: string, row: Cafe24ApiOrder) {
  return businessKey(connectionId, row.orderNo, row.lineOrderNo, normalizeProductNo(row.productNo), row.optionName);
}
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function validDay(date: Date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(10) !== "T00:00:00.000Z") invalid("Expected a UTC date-only value.");
  return date.toISOString().slice(0, 10);
}
function validTimestamp(date: Date) { return date instanceof Date && Number.isFinite(date.getTime()); }
function requiredId(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) invalid("Required provider identity is invalid.");
}
function requiredActionReportTime(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 64)
    invalid("Meta actionReportTime must be a nonempty value of at most 64 characters.");
}
function sameCreativeParts(expected: CreativeNameParts, actual: CreativeNameParts | null | undefined) {
  return actual != null && expected.originalName === actual.originalName &&
    expected.dateCode === actual.dateCode && expected.productName === actual.productName &&
    expected.materialNo === actual.materialNo && expected.setting === actual.setting &&
    expected.creativeKey === actual.creativeKey && expected.displayName === actual.displayName &&
    expected.parseStatus === actual.parseStatus;
}
function requiredName(value: string) {
  if (typeof value !== "string" || !value.trim()) invalid("Provider name is required.");
}
function decimal(value: string, precision: number, scale: number, field: string) {
  if (typeof value !== "string" || !new RegExp(`^\\d{1,${precision - scale}}(?:\\.\\d{1,${scale}})?$`).test(value))
    invalid(`${field} must be a nonnegative decimal string.`);
  return new Prisma.Decimal(value);
}
function optionalDecimal(value: string | null | undefined) {
  return value == null ? null : decimal(value, 18, 2, "optional KRW amount");
}
function optionalMetaDecimal(value: string | null | undefined, precision: number, scale: number) {
  return value == null ? null : decimal(value, precision, scale, "optional Meta measure");
}
function count(value: number | undefined, field: string, required = false) {
  if ((required && value === undefined) ||
      (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)))
    invalid(`${field} must be a nonnegative int32.`);
}
function metaMeasures(row: MetaApiAd | MetaApiAdset, isAd: boolean) {
  if ((row.currentMetadata == null) !== (row.metadataObservedAt == null))
    invalid("Meta current metadata and observation timestamp must be provided together.");
  if (row.currentMetadata != null) {
    if (!validCurrentMetadata(row.currentMetadata) || !(row.metadataObservedAt instanceof Date) ||
        !Number.isFinite(row.metadataObservedAt.getTime()) || row.metadataObservedAt.getTime() > Date.now() + 300_000 ||
        (isAd ? row.currentMetadata.ad === null : row.currentMetadata.ad !== null))
      invalid("Invalid Meta current asset observation.");
    const asset = isAd ? row.currentMetadata.ad! : row.currentMetadata.adset;
    if ((row.deliveryStatus ?? null) !== currentDeliveryStatus(asset))
      invalid("Meta delivery status must match the observed current effective status.");
  }
  const allowedReasonFields = ["resultCount", "purchaseCount", "shopClicks", "landingPageViews", "videoPlay3sCount",
    "videoPlay25Count", "videoPlay50Count", "videoPlay75Count", "videoPlay100Count", "addToCartCount"];
  if (!row.metricUnavailableReasons || typeof row.metricUnavailableReasons !== "object" || Array.isArray(row.metricUnavailableReasons) ||
      Object.entries(row.metricUnavailableReasons).some(([field, reason]) => !allowedReasonFields.includes(field) ||
        !META_UNAVAILABLE_REASONS.includes(reason))) invalid("Invalid Meta conditional metric reason map.");
  decimal(row.spendUsd, 14, 4, "spendUsd");
  if (typeof row.impressions !== "string" || !/^\d+$/.test(row.impressions) ||
      BigInt(row.impressions) > 9_223_372_036_854_775_807n) invalid("impressions must be an int64 decimal string.");
  count(row.inlineLinkClicks, "inlineLinkClicks", true);
  if(row.currentMetadata?.sourceContext?.rawLinkClickNull===true&&row.inlineLinkClicks!==0)
    invalid("Derived Meta link clicks must be zero.");
  conditionalCount(row, "resultCount");
  count(row.reach, "reach", true);
  if (isAd) conditionalCount(row, "purchaseCount");
  const purchaseContext=row.currentMetadata?.sourceContext?.purchaseMeasurement;
  if(purchaseContext){
    if(row.purchaseCount==null||row.purchaseValueUsd==null)invalid("MCP purchases require explicit count and value.");
    if(!isAd)conditionalCount(row,"purchaseCount");decimal(row.purchaseValueUsd!,14,4,"purchaseValueUsd");
    if(row.currentMetadata?.sourceContext?.rawPurchaseNull===true&&(row.purchaseCount!==0||!new Prisma.Decimal(row.purchaseValueUsd!).isZero()))invalid("Derived purchases must be zero count and value.");
  }else if(row.purchaseValueUsd!=null||!isAd&&row.purchaseCount!=null)invalid("Provider purchase value requires verified source provenance.");
  if (row.attributionSetting !== null && (typeof row.attributionSetting !== "string" ||
      !row.attributionSetting.trim() || row.attributionSetting.length > 128)) invalid("Invalid Meta attribution setting.");
  const mcpContext = row.actionReportTime === "MCP_PROVIDER_DEFAULT_UNVERIFIED";
  if (mcpContext && (row.currentMetadata?.sourceContext?.transport !== "MCP" || row.attributionSetting !== null ||
      ["resultCount", "landingPageViews", ...(isAd ? [...(purchaseContext?[]:["purchaseCount"]), "addToCartCount", "videoPlay3sCount", "videoPlay25Count", "videoPlay50Count", "videoPlay75Count", "videoPlay100Count"] : [])]
        .some(field => (row as unknown as Record<string, unknown>)[field] !== null)))
    invalid("MCP provider-default actions need explicit unavailable measurements and source context.");
  if (row.currentMetadata?.sourceContext?.transport === "MCP" && !mcpContext)
    invalid("MCP metadata needs the provider-default request context.");
  if (!Array.isArray(row.attributionWindows) || (mcpContext ? row.attributionWindows.length !== 0 : row.attributionWindows.length < 1) ||
      row.attributionWindows.length > 4 || new Set(row.attributionWindows).size !== row.attributionWindows.length ||
      row.attributionWindows.some((window) => !["1d_click", "7d_click", "1d_view", "7d_view"].includes(window)))
    invalid("Invalid Meta request attribution windows.");
  if (isAd) {
    for (const field of ["videoPlay3sCount", "videoPlay25Count", "videoPlay50Count",
      "videoPlay75Count", "videoPlay100Count", "addToCartCount"] as const) {
      conditionalCount(row, field);
    }
  }
  count(row.clicksAll, "clicksAll", true);
  conditionalCount(row, "shopClicks"); conditionalCount(row, "landingPageViews");
  const actionFields = isAd ? ["resultCount", "landingPageViews", ...(mcpContext&&purchaseContext?[]:["purchaseCount"]), "addToCartCount",
    "videoPlay3sCount", "videoPlay25Count", "videoPlay50Count", "videoPlay75Count", "videoPlay100Count"]
    : ["resultCount", "landingPageViews"];
  if (row.attributionSetting === null && actionFields.some((field) =>
      (row as unknown as Record<string, unknown>)[field] !== null)) invalid("Known Meta actions require an attribution setting.");
  for (const [field, precision, scale] of [
    ["frequency", 12, 6], ["costPerResultUsd", 14, 4], ["cpmUsd", 14, 4],
    ["cpcLinkUsd", 14, 4], ["ctrLinkPct", 10, 6], ["ctrAllPct", 10, 6],
    ["cpcAllUsd", 14, 4], ["costPerLandingPageViewUsd", 14, 4]
  ] as const) {
    if (row[field] != null) decimal(row[field], precision, scale, field);
  }
  if ("startDate" in row && row.startDate != null) validDay(row.startDate);
}
function conditionalCount(row: MetaApiAd | MetaApiAdset, field: string) {
  const value = (row as unknown as Record<string, unknown>)[field];
  const reason = row.metricUnavailableReasons?.[field];
  if (value === undefined) invalid(`Meta ${field} must be an explicit number or null.`);
  if (value === null) {
    if (!META_UNAVAILABLE_REASONS.includes(reason)) invalid(`Meta ${field} needs a safe unavailability reason.`);
  } else {
    count(value as number, field, true);
    if (reason !== undefined) invalid(`Meta ${field} cannot have both a value and an unavailable reason.`);
  }
}
function cafe24Measures(row: Cafe24ApiOrder) {
  decimal(row.quantity, 14, 4, "quantity");
  decimal(row.salePriceKrw, 14, 2, "salePriceKrw");
  decimal(row.totalPaidKrw, 14, 2, "totalPaidKrw");
  optionalDecimal(row.totalOrderKrw);
  optionalDecimal(row.actualOrderPriceKrw);
  optionalDecimal(row.actualPaymentKrw);
  optionalDecimal(row.actualShippingFeeKrw);
  optionalDecimal(row.initialOrderPriceKrw);
  optionalDecimal(row.initialPaymentKrw);
  optionalDecimal(row.initialShippingFeeKrw);
  optionalDecimal(row.cancelAmountKrw);
  optionalDecimal(row.refundAmountKrw);
  optionalDecimal(row.discountAmountKrw);
  optionalDecimal(row.couponAmountKrw);
}
function validateCafe24Order(row: Cafe24ApiOrder) {
  [row.orderNo, row.lineOrderNo, row.productNo].forEach(requiredId);
  requiredName(row.productName);
  if (!cafe24OptionCompositionFits(row.optionName) ||
      (row.paymentMethod !== null &&
        (typeof row.paymentMethod !== "string" || row.paymentMethod.length > 256)) ||
      (row.orderStatus != null && (typeof row.orderStatus !== "string" || row.orderStatus.length > 64)) ||
      (row.lineStatus != null && (typeof row.lineStatus !== "string" || row.lineStatus.length > 64)))
    invalid("Cafe24 option, payment, or status exceeds the canonical field limit.");
  const codes = row.providerPaymentCodes ?? null;
  if (codes !== null && (!Array.isArray(codes) || codes.length < 1 || codes.length > 16 ||
      !codes.every((code) => typeof code === "string" && code.length > 0 &&
        code.length <= 64 && !/[\u0000-\u001f\u007f]/.test(code))))
    invalid("Cafe24 provider payment code array is invalid.");
  if (row.providerCouponSignal != null && typeof row.providerCouponSignal !== "boolean")
    invalid("Cafe24 provider coupon signal is invalid.");
  if (row.totalPaidInputSource != null && row.totalPaidInputSource !== "ORDERS_PAYMENT_AMOUNT")
    invalid("Cafe24 paid amount source is invalid.");
  if (codes === null && row.providerCouponSignal != null)
    invalid("Cafe24 coupon signal needs provider payment codes.");
  const day = validDay(row.orderDate);
  if (!validTimestamp(row.orderedAt) ||
      (row.providerUpdatedAt !== null && !validTimestamp(row.providerUpdatedAt)))
    invalid("Cafe24 order date or timestamp is invalid.");
  if (formatInTimeZone(row.orderedAt, "Asia/Seoul", "yyyy-MM-dd") !== day)
    invalid("Cafe24 orderDate must equal the Asia/Seoul date of orderedAt.");
  if ((row.cancelledAt != null && !validTimestamp(row.cancelledAt)) ||
      (row.refundedAt != null && !validTimestamp(row.refundedAt)))
    invalid("Cafe24 cancellation/refund timestamp is invalid.");
  cafe24Measures(row);
  return day;
}
function sameMetaBase(stored: MetaAdDailyMetric | MetaAdsetDailyMetric, row: MetaApiAd | MetaApiAdset) {
  const decimalEqual = (before: Prisma.Decimal | null, after: string | null | undefined) =>
    before === null ? after == null : after != null && before.eq(after);
  return stored.spendUsd.eq(row.spendUsd) && stored.impressions === BigInt(row.impressions) &&
    decimalEqual(stored.purchaseValueUsd,row.purchaseValueUsd) && stored.purchaseCount===(row.purchaseCount??null) &&
    stored.linkClicks === row.inlineLinkClicks && stored.resultCount === row.resultCount &&
    stored.reach === row.reach && stored.attributionSetting === row.attributionSetting &&
    stored.actionReportTime === row.actionReportTime.trim() &&
    JSON.stringify(stored.attributionWindows) === JSON.stringify(row.attributionWindows) &&
    sortedReasonJson(stored.metricUnavailableReasons) === sortedReasonJson(row.metricUnavailableReasons) &&
    stableMetadataJson(stored.currentMetadata) === stableMetadataJson(row.currentMetadata) &&
    stored.shopClicks === row.shopClicks && stored.clicksAll === row.clicksAll &&
    stored.landingPageViews === row.landingPageViews &&
    decimalEqual(stored.frequency, row.frequency) &&
    decimalEqual(stored.costPerResultUsd, row.costPerResultUsd) &&
    decimalEqual(stored.cpmUsd, row.cpmUsd) &&
    decimalEqual(stored.cpcLinkUsd, row.cpcLinkUsd) &&
    decimalEqual(stored.ctrLinkPct, row.ctrLinkPct) &&
    decimalEqual(stored.ctrAllPct, row.ctrAllPct) &&
    decimalEqual(stored.cpcAllUsd, row.cpcAllUsd) &&
    decimalEqual(stored.costPerLandingPageViewUsd, row.costPerLandingPageViewUsd) &&
    stored.adsetBudgetLabel === (row.adsetBudgetLabel ?? null) &&
    stored.adsetBudgetType === (row.adsetBudgetType ?? null) &&
    stored.endStatus === (row.endStatus ?? null) &&
    stored.resultIndicator === (row.resultIndicator ?? null);
}
function sameMetaAd(stored: MetaAdDailyMetric, row: MetaApiAd, creativeId: string) {
  return sameMetaBase(stored, row) && stored.creativeId === creativeId &&
    stored.metaCampaignId === row.campaignId &&
    stored.metaAdsetId === row.adsetId && stored.metaAdId === row.adId &&
    stored.campaignNameSnapshot === row.campaignName &&
    stored.adsetNameSnapshot === row.adsetName && stored.adNameSnapshot === row.adName &&
    stored.adDeliveryStatus === (row.deliveryStatus ?? null) &&
    stored.purchaseCount === row.purchaseCount &&
    stored.videoPlay3sCount === (row.videoPlay3sCount ?? null) &&
    stored.videoPlay25Count === (row.videoPlay25Count ?? null) &&
    stored.videoPlay50Count === (row.videoPlay50Count ?? null) &&
    stored.videoPlay75Count === (row.videoPlay75Count ?? null) &&
    stored.videoPlay100Count === (row.videoPlay100Count ?? null) &&
    stored.addToCartCount === (row.addToCartCount ?? null) &&
    stored.qualityRanking === (row.qualityRanking ?? null) &&
    stored.engagementRateRanking === (row.engagementRateRanking ?? null) &&
    stored.conversionRateRanking === (row.conversionRateRanking ?? null);
}
function sameMetaAdset(stored: MetaAdsetDailyMetric, row: MetaApiAdset) {
  return sameMetaBase(stored, row) && stored.adsetName === row.adsetName &&
    stored.deliveryStatus === (row.deliveryStatus ?? null) &&
    (stored.startDate?.getTime() ?? null) === (row.startDate?.getTime() ?? null);
}
function sameCafe24Version(prior: {
  productNo: string; optionName: string; orderNo: string; lineOrderNo: string;
  quantity: Prisma.Decimal; salePriceKrw: Prisma.Decimal; totalOrderKrw: Prisma.Decimal | null;
  totalPaidKrw: Prisma.Decimal; paymentMethod: string | null; orderedAt: Date; orderDate: Date;
  totalPaidInputSource?: string | null;
  providerPaymentCodes?: Prisma.JsonValue | null; providerCouponSignal?: boolean | null;
  actualOrderPriceKrw?: Prisma.Decimal | null; actualPaymentKrw?: Prisma.Decimal | null;
  actualShippingFeeKrw?: Prisma.Decimal | null;
  initialOrderPriceKrw?: Prisma.Decimal | null; initialPaymentKrw?: Prisma.Decimal | null;
  initialShippingFeeKrw?: Prisma.Decimal | null;
  providerUpdatedAt: Date | null;
  orderStatus: string | null; lineStatus: string | null;
  cancelledAt: Date | null; cancelAmountKrw: Prisma.Decimal | null;
  refundedAt: Date | null; refundAmountKrw: Prisma.Decimal | null;
  discountAmountKrw: Prisma.Decimal | null; couponAmountKrw: Prisma.Decimal | null;
}, row: Cafe24ApiOrder, productNo: string) {
  const sameAmount = (before: Prisma.Decimal | null, after: string | null | undefined) =>
    before === null ? after == null : after != null && before.eq(after);
  const sameTime = (before: Date | null, after: Date | null | undefined) =>
    (before?.getTime() ?? null) === (after?.getTime() ?? null);
  const sameProviderAmount = (before: Prisma.Decimal | null | undefined, after: string | null | undefined) =>
    before == null ? after == null : after != null && before.eq(after);
  return prior.orderNo === row.orderNo.trim() && prior.lineOrderNo === row.lineOrderNo.trim() &&
    sameTime(prior.providerUpdatedAt, row.providerUpdatedAt) &&
    prior.productNo === productNo && prior.optionName === row.optionName.trim() &&
    prior.quantity.eq(row.quantity) && prior.salePriceKrw.eq(row.salePriceKrw) &&
    (prior.totalOrderKrw === null ? row.totalOrderKrw === null :
      row.totalOrderKrw !== null && prior.totalOrderKrw.eq(row.totalOrderKrw)) &&
    prior.totalPaidKrw.eq(row.totalPaidKrw) &&
    (prior.totalPaidInputSource ?? null) === (row.totalPaidInputSource ?? null) &&
    prior.paymentMethod === row.paymentMethod &&
    sameCafe24ProviderCodes(prior.providerPaymentCodes, row.providerPaymentCodes) &&
    (prior.providerCouponSignal ?? null) === (row.providerCouponSignal ?? null) &&
    sameProviderAmount(prior.actualOrderPriceKrw, row.actualOrderPriceKrw) &&
    sameProviderAmount(prior.actualPaymentKrw, row.actualPaymentKrw) &&
    sameProviderAmount(prior.actualShippingFeeKrw, row.actualShippingFeeKrw) &&
    sameProviderAmount(prior.initialOrderPriceKrw, row.initialOrderPriceKrw) &&
    sameProviderAmount(prior.initialPaymentKrw, row.initialPaymentKrw) &&
    sameProviderAmount(prior.initialShippingFeeKrw, row.initialShippingFeeKrw) &&
    prior.orderedAt.getTime() === row.orderedAt.getTime() &&
    prior.orderDate.getTime() === row.orderDate.getTime() &&
    prior.orderStatus === (row.orderStatus ?? null) && prior.lineStatus === (row.lineStatus ?? null) &&
    sameTime(prior.cancelledAt, row.cancelledAt) && sameAmount(prior.cancelAmountKrw, row.cancelAmountKrw) &&
    sameTime(prior.refundedAt, row.refundedAt) && sameAmount(prior.refundAmountKrw, row.refundAmountKrw) &&
    sameAmount(prior.discountAmountKrw, row.discountAmountKrw) &&
    sameAmount(prior.couponAmountKrw, row.couponAmountKrw);
}
function sameCafe24CurrentLine(line: {
  orderNo: string; lineOrderNo: string; productNo: string; productName: string;
  optionName: string; quantity: Prisma.Decimal; salePriceKrw: Prisma.Decimal;
  totalOrderKrw: Prisma.Decimal | null; totalPaidKrw: Prisma.Decimal;
  totalPaidInputSource?: string | null;
  paymentMethod: string | null; orderedAt: Date | null; orderDate: Date | null;
  providerPaymentCodes?: Prisma.JsonValue | null; providerCouponSignal?: boolean | null;
  actualOrderPriceKrw?: Prisma.Decimal | null; actualPaymentKrw?: Prisma.Decimal | null;
  actualShippingFeeKrw?: Prisma.Decimal | null;
  initialOrderPriceKrw?: Prisma.Decimal | null; initialPaymentKrw?: Prisma.Decimal | null;
  initialShippingFeeKrw?: Prisma.Decimal | null;
  providerUpdatedAt: Date | null; importVersion: number;
}, prior: {
  orderNo: string; lineOrderNo: string; productNo: string; optionName: string;
  quantity: Prisma.Decimal; salePriceKrw: Prisma.Decimal;
  totalOrderKrw: Prisma.Decimal | null; totalPaidKrw: Prisma.Decimal;
  totalPaidInputSource?: string | null;
  paymentMethod: string | null; orderedAt: Date; orderDate: Date;
  providerPaymentCodes?: Prisma.JsonValue | null; providerCouponSignal?: boolean | null;
  actualOrderPriceKrw?: Prisma.Decimal | null; actualPaymentKrw?: Prisma.Decimal | null;
  actualShippingFeeKrw?: Prisma.Decimal | null;
  initialOrderPriceKrw?: Prisma.Decimal | null; initialPaymentKrw?: Prisma.Decimal | null;
  initialShippingFeeKrw?: Prisma.Decimal | null;
  providerUpdatedAt: Date | null; version: number;
}) {
  return line.importVersion === prior.version &&
    line.orderNo === prior.orderNo && line.lineOrderNo === prior.lineOrderNo &&
    line.productNo === prior.productNo && line.optionName === prior.optionName &&
    line.quantity.eq(prior.quantity) && line.salePriceKrw.eq(prior.salePriceKrw) &&
    (line.totalOrderKrw === null ? prior.totalOrderKrw === null :
      prior.totalOrderKrw !== null && line.totalOrderKrw.eq(prior.totalOrderKrw)) &&
    line.totalPaidKrw.eq(prior.totalPaidKrw) &&
    (line.totalPaidInputSource ?? null) === (prior.totalPaidInputSource ?? null) &&
    line.paymentMethod === prior.paymentMethod &&
    sameCafe24ProviderCodes(line.providerPaymentCodes, prior.providerPaymentCodes) &&
    (line.providerCouponSignal ?? null) === (prior.providerCouponSignal ?? null) &&
    sameCafe24StoredAmount(line.actualOrderPriceKrw, prior.actualOrderPriceKrw) &&
    sameCafe24StoredAmount(line.actualPaymentKrw, prior.actualPaymentKrw) &&
    sameCafe24StoredAmount(line.actualShippingFeeKrw, prior.actualShippingFeeKrw) &&
    sameCafe24StoredAmount(line.initialOrderPriceKrw, prior.initialOrderPriceKrw) &&
    sameCafe24StoredAmount(line.initialPaymentKrw, prior.initialPaymentKrw) &&
    sameCafe24StoredAmount(line.initialShippingFeeKrw, prior.initialShippingFeeKrw) &&
    line.orderedAt?.getTime() === prior.orderedAt.getTime() &&
    line.orderDate?.getTime() === prior.orderDate.getTime() &&
    (line.providerUpdatedAt?.getTime() ?? null) ===
      (prior.providerUpdatedAt?.getTime() ?? null);
}
function sameCafe24StoredAmount(left: Prisma.Decimal | null | undefined,
  right: Prisma.Decimal | null | undefined) {
  return left == null || right == null ? left == null && right == null : left.eq(right);
}
function sameCafe24ProviderCodes(left: Prisma.JsonValue | null | undefined,
  right: Prisma.JsonValue | null | undefined) {
  const normalize = (value: Prisma.JsonValue | null | undefined) =>
    value === (Prisma.DbNull as unknown) || value === (Prisma.JsonNull as unknown)
      ? null : value ?? null;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
function invalid(message: string): never {
  throw new BadRequestException({ code: "INVALID_CANONICAL_ROW", message });
}

function sortedReasonJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "null";
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
