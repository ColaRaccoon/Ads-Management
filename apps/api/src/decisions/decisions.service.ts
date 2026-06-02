import { BadRequestException, Injectable } from "@nestjs/common";
import { AdStage, DecisionType, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { parseDateRange } from "../common/date-range";
import { DecisionClassifier } from "../domain/decision-classifier";
import { MetricsService, parseDeliveryStatusFilter } from "../metrics/metrics.service";

@Injectable()
export class DecisionsService {
  private readonly classifier = new DecisionClassifier();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService
  ) {}

  async run(body: { from?: string; to?: string; compareType?: string; filters?: Record<string, unknown> }) {
    const range = parseDateRange(body.from, body.to);
    const requestedDeliveryStatus = typeof body.filters?.deliveryStatus === "string" ? body.filters.deliveryStatus : undefined;
    const deliveryStatus = parseDeliveryStatusFilter(requestedDeliveryStatus);
    const filters = { ...(body.filters ?? {}), deliveryStatus };
    const settings = await this.decisionSettings();
    const decisionRun = await this.prisma.decisionRun.create({
      data: {
        periodStart: range.fromDate,
        periodEnd: range.toDate,
        compareType: body.compareType,
        filters: filters as Prisma.InputJsonObject
      }
    });

    const [summary, products, adsets] = await Promise.all([
      this.metricsService.dashboardSummary(range.from, range.to, undefined, deliveryStatus),
      this.metricsService.productMetrics(range.from, range.to, deliveryStatus),
      this.metricsService.adsetMetrics({ from: range.from, to: range.to, deliveryStatus })
    ]);

    const logs: Prisma.DecisionLogCreateManyInput[] = [];
    const overallDecisions = this.classifier.classify({
      scopeType: "OVERALL",
      stage: "UNKNOWN",
      purchaseCount: summary.totals.purchaseCount,
      spendKrw: summary.totals.spendKrw,
      cpaKrw: summary.totals.cpaKrw,
      marginKrw: summary.totals.marginKrw,
      dataDays: summary.selectedPeriod.dataDays,
      ctrLinkPct: summary.totals.ctrLinkPct,
      landingPageViews: summary.totals.landingPageViews,
      breakEvenCpaKrw: null,
      targetCpaKrw: null,
      watchCpaKrw: null,
      stopCpaKrw: null,
      ...settings
    });
    logs.push(...this.toLogs(decisionRun.id, range, "OVERALL", overallDecisions, summary.totals, {}));

    for (const product of products) {
      if (!product.thresholds) {
        logs.push({
          decisionRunId: decisionRun.id,
          periodStart: range.fromDate,
          periodEnd: range.toDate,
          scopeType: "PRODUCT",
          productId: product.productId,
          decision: DecisionType.WATCH,
          severity: 2,
          reason: "제품 원가/CPA 기준이 설정되지 않아 판정을 보류합니다.",
          recommendedAction: "Product Settings에서 원가 rule과 CPA rule을 입력하세요.",
          metricsSnapshot: product as Prisma.InputJsonObject,
          ruleSnapshot: { ruleStatus: product.ruleStatus }
        });
        continue;
      }
      const decisions = this.classifier.classify({
        scopeType: "PRODUCT",
        stage: "UNKNOWN",
        purchaseCount: product.totals.purchaseCount,
        spendKrw: product.totals.spendKrw,
        cpaKrw: product.totals.cpaKrw,
        marginKrw: product.totals.marginKrw,
        dataDays: product.dataDays,
        ctrLinkPct: product.totals.ctrLinkPct,
        landingPageViews: product.totals.landingPageViews,
        breakEvenCpaKrw: product.thresholds.breakEvenCpaKrw,
        targetCpaKrw: product.thresholds.targetCpaKrw,
        watchCpaKrw: product.thresholds.watchCpaKrw,
        stopCpaKrw: product.thresholds.stopCpaKrw,
        ...settings
      });
      logs.push(
        ...this.toLogs(decisionRun.id, range, "PRODUCT", decisions, product.totals, product.thresholds, {
          productId: product.productId
        })
      );
    }

    for (const adset of adsets) {
      if (!adset.thresholds) {
        logs.push({
          decisionRunId: decisionRun.id,
          periodStart: range.fromDate,
          periodEnd: range.toDate,
          scopeType: "ADSET",
          metaAdsetId: adset.metaAdsetId,
          stage: adset.stage,
          decision: DecisionType.WATCH,
          severity: 2,
          reason: "광고세트의 제품 매칭 또는 기준 설정이 없어 판정을 보류합니다.",
          recommendedAction: "Mappings 또는 Product Settings에서 기준을 보완하세요.",
          metricsSnapshot: adset as Prisma.InputJsonObject,
          ruleSnapshot: { ruleStatus: adset.ruleStatus }
        });
        continue;
      }
      const decisions = this.classifier.classify({
        scopeType: "ADSET",
        stage: adset.stage,
        purchaseCount: adset.totals.purchaseCount,
        spendKrw: adset.totals.spendKrw,
        cpaKrw: adset.totals.cpaKrw,
        marginKrw: adset.totals.marginKrw,
        dataDays: adset.dataDays,
        ctrLinkPct: adset.totals.ctrLinkPct,
        landingPageViews: adset.totals.landingPageViews,
        breakEvenCpaKrw: adset.thresholds.breakEvenCpaKrw,
        targetCpaKrw: adset.thresholds.targetCpaKrw,
        watchCpaKrw: adset.thresholds.watchCpaKrw,
        stopCpaKrw: adset.thresholds.stopCpaKrw,
        ...settings
      });
      logs.push(
        ...this.toLogs(decisionRun.id, range, "ADSET", decisions, adset.totals, adset.thresholds, {
          metaAdsetId: adset.metaAdsetId,
          productId: adset.product?.id,
          stage: adset.stage
        })
      );
    }

    const stageGroups = new Map<AdStage, typeof adsets>();
    for (const adset of adsets) {
      stageGroups.set(adset.stage, [...(stageGroups.get(adset.stage) ?? []), adset]);
    }
    for (const [stage, rows] of stageGroups.entries()) {
      const marginKrw = rows.reduce((sum, row) => sum + (row.totals.marginKrw ?? 0), 0);
      if (marginKrw !== 0) {
        logs.push({
          decisionRunId: decisionRun.id,
          periodStart: range.fromDate,
          periodEnd: range.toDate,
          scopeType: "STAGE",
          stage,
          decision: marginKrw > 0 ? DecisionType.PROFIT : DecisionType.LOSS,
          severity: marginKrw > 0 ? 1 : 3,
          reason: `${stage} 단계 기준 ${marginKrw > 0 ? "흑자" : "손실"}입니다.`,
          recommendedAction: "단계별 예산 배분 후보를 검토하고 변경 시 로그로 기록하세요.",
          metricsSnapshot: { stage, marginKrw, adsetCount: rows.length },
          ruleSnapshot: {}
        });
      }
    }

    if (logs.length > 0) {
      await this.prisma.decisionLog.createMany({ data: logs });
    }
    const savedLogs = await this.prisma.decisionLog.findMany({
      where: { decisionRunId: decisionRun.id },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }]
    });
    return { decisionRun, logs: savedLogs, count: savedLogs.length };
  }

  list(from?: string, to?: string) {
    if (!from || !to) {
      return this.prisma.decisionLog.findMany({
        orderBy: [{ decisionDate: "desc" }, { severity: "desc" }],
        take: 100,
        include: { product: true, metaAdset: true }
      });
    }
    const range = parseDateRange(from, to);
    return this.prisma.decisionLog.findMany({
      where: { periodStart: range.fromDate, periodEnd: range.toDate },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      include: { product: true, metaAdset: true }
    });
  }

  private toLogs(
    decisionRunId: string,
    range: ReturnType<typeof parseDateRange>,
    scopeType: string,
    decisions: ReturnType<DecisionClassifier["classify"]>,
    metricsSnapshot: unknown,
    ruleSnapshot: unknown,
    ids: { productId?: string | null; metaAdsetId?: string | null; stage?: AdStage | null } = {}
  ): Prisma.DecisionLogCreateManyInput[] {
    return decisions.map((decision) => ({
      decisionRunId,
      periodStart: range.fromDate,
      periodEnd: range.toDate,
      scopeType,
      productId: ids.productId ?? null,
      metaAdsetId: ids.metaAdsetId ?? null,
      stage: ids.stage ?? null,
      decision: decision.decision as DecisionType,
      severity: decision.severity,
      reason: decision.reason,
      recommendedAction: decision.recommendedAction,
      metricsSnapshot: metricsSnapshot as Prisma.InputJsonValue,
      ruleSnapshot: ruleSnapshot as Prisma.InputJsonValue
    }));
  }

  private async decisionSettings() {
    const settings = await this.prisma.appSetting.findMany({
      where: { key: { in: ["good_ctr_link_pct", "good_landing_page_view_count"] } }
    });
    const map = new Map(settings.map((setting) => [setting.key, setting.valueJson]));
    return {
      goodCtrLinkPct: Number(map.get("good_ctr_link_pct") ?? 1),
      goodLandingPageViewCount: Number(map.get("good_landing_page_view_count") ?? 3)
    };
  }
}
