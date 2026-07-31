import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma, RowValidationStatus, UploadStatus } from "@prisma/client";
import { numberFrom, parseDateRange } from "../common/date-range";
import {
  allocateNonNegativeByWeight,
  Cafe24CouponResolution,
  Cafe24CouponRuleInput,
  resolveCafe24CouponOrder
} from "../domain/cafe24-coupon-matcher";
import { Cafe24SalesCalculator } from "../domain/cafe24-sales-calculator";
import { formatDateOnly, safeDivide, toDateOnly } from "../domain/date-number";
import { PrismaService } from "../common/prisma.service";
import { isCompleteCafe24UploadBatch } from "./cafe24-uploads.service";

type Cafe24Line = Prisma.Cafe24OrderLineGetPayload<{
  include: { product: true; matchRule: true };
}>;
type AdMetric = Prisma.MetaAdsetDailyMetricGetPayload<{
  include: { product: true };
}>;
type CostRule = Prisma.ProductCostRuleGetPayload<Record<string, never>>;
type ExchangeRateRow = Prisma.ExchangeRateGetPayload<Record<string, never>>;
type CouponRule = Prisma.Cafe24CouponRuleGetPayload<Record<string, never>>;
type ProductSnapshot = {
  id: string;
  code?: string;
  name?: string;
  displayName?: string;
  isActive?: boolean;
} | null;

type RuleStatus =
  | "OK"
  | "UNMATCHED"
  | "MISSING_COST_RULE"
  | "MISSING_EXCHANGE_RATE"
  | "MISSING_RULES"
  | "PRICE_MISMATCH";

type CouponAggregateStatus = "NO_COUPON" | "EXACT" | "ESTIMATED" | "UNMATCHED" | "MIXED";
type CouponMatchFilter = "EXACT" | "ESTIMATED" | "UNMATCHED";

@Injectable()
export class SalesMetricsService {
  private readonly calculator = new Cafe24SalesCalculator();

  constructor(private readonly prisma: PrismaService) {}

  async productPerformance(query: { from?: string; to?: string; deliveryStatus?: string }) {
    const range = parseDateRange(query.from, query.to);
    const deliveryStatus = parseOptionalDeliveryStatusFilter(query.deliveryStatus);
    const [salesData, adMetrics] = await Promise.all([
      this.cafe24SalesLines(range),
      this.prisma.metaAdsetDailyMetric.findMany({
        where: {
          isCurrent: true,
          metricDate: { gte: range.fromDate, lte: range.toDate },
          ...deliveryStatusWhere(deliveryStatus)
        },
        include: { product: true },
        orderBy: [{ metricDate: "asc" }, { adsetName: "asc" }]
      })
    ]);
    const salesLines = salesData.salesLines;

    const productIds = uniqueNonEmpty([
      ...salesLines.map(activeLineProductId),
      ...adMetrics.map(activeMetricProductId)
    ]);
    const metricDates = uniqueNonEmpty(adMetrics.map((metric) => formatDateOnly(metric.metricDate)));
    const [costRules, exchangeRates, couponRules] = await Promise.all([
      productIds.length > 0
        ? this.prisma.productCostRule.findMany({
            where: { productId: { in: productIds } },
            orderBy: { effectiveFrom: "desc" }
          })
        : Promise.resolve([] as CostRule[]),
      metricDates.length > 0
        ? this.prisma.exchangeRate.findMany({
            where: {
              baseCurrency: "USD",
              quoteCurrency: "KRW",
              provider: "KOREA_EXIM",
              rateDate: { in: metricDates.map((date) => toDateOnly(date)).filter((date): date is Date => Boolean(date)) }
            }
          })
        : Promise.resolve([] as ExchangeRateRow[]),
      this.findCouponRules(range, productIds)
    ]);

    const costRulesByProductId = groupBy(costRules, (rule) => rule.productId);
    const exchangeRateByDate = new Map(exchangeRates.map((rate) => [formatDateOnly(rate.rateDate), rate]));
    const couponAggregation = this.resolveCouponOrders(salesData.couponLines, couponRules);
    const salesByProductId = this.aggregateSales(
      salesLines,
      costRulesByProductId,
      range.fromDate,
      couponAggregation.byProductId
    );
    const adSpend = this.aggregateAdSpend(adMetrics, costRulesByProductId, exchangeRateByDate);
    const productById = productMap(salesLines, adMetrics);
    const allProductIds = Array.from(new Set([...salesByProductId.keys(), ...adSpend.byProductId.keys()])).sort((a, b) =>
      productLabel(productById.get(a)).localeCompare(productLabel(productById.get(b)))
    );

    const rows = allProductIds.map((productId) => {
      const sales = salesByProductId.get(productId) ?? emptySalesAccumulator(productById.get(productId) ?? null);
      const ads = adSpend.byProductId.get(productId) ?? emptyAdAccumulator();
      const adSpendKrw = ads.hasMissingExchangeRate ? null : ads.spendKrw;
      const grossCostKrw = sales.missingCostRule ? null : sales.grossCostKrw;
      const baseTotalCostKrw = adSpendKrw === null || grossCostKrw === null ? null : grossCostKrw + adSpendKrw;
      const marginBeforeCouponKrw =
        baseTotalCostKrw === null ? null : sales.revenueKrw - baseTotalCostKrw;
      const totalCostKrw =
        baseTotalCostKrw === null ? null : baseTotalCostKrw + sales.couponDeductionKrw;
      const marginKrw =
        marginBeforeCouponKrw === null ? null : marginBeforeCouponKrw - sales.couponDeductionKrw;
      return {
        productId,
        product: productById.get(productId) ?? sales.product,
        quantity: sales.quantity,
        revenueKrw: sales.revenueKrw,
        totalPaidKrw: sales.totalPaidKrw,
        adSpendUsd: ads.spendUsd,
        adSpendKrw,
        grossCostKrw,
        totalCostKrw,
        marginBeforeCouponKrw,
        couponDeductionKrw: sales.couponDeductionKrw,
        couponOrderCount: sales.couponOrderCount,
        couponExactOrderCount: sales.couponExactOrderCount,
        couponEstimatedOrderCount: sales.couponEstimatedOrderCount,
        couponUnmatchedOrderCount: sales.couponUnmatchedOrderCount,
        couponIgnoredResidualKrw: sales.couponIgnoredResidualKrw,
        couponStatus: summarizeCouponStatus(sales),
        marginKrw,
        roas: adSpendKrw === null ? null : safeDivide(sales.revenueKrw, adSpendKrw),
        cpaKrw: adSpendKrw === null ? null : safeDivide(adSpendKrw, sales.quantity),
        marginRate: marginKrw === null ? null : safeDivide(marginKrw, sales.revenueKrw),
        matchedSalesLineCount: sales.lineCount,
        priceMismatchCount: sales.priceMismatchCount,
        ruleStatus: summarizeRuleStatus(sales, ads)
      };
    });

    return {
      period: { from: range.from, to: range.to },
      rows,
      summary: {
        salesLineCount: salesLines.length,
        salesUnmatchedCount: salesLines.filter((line) => !activeLineProductId(line)).length,
        adMetricCount: adMetrics.length,
        adUnmatchedMetricCount: adSpend.unmatched.metricCount,
        adUnmatchedSpendUsd: adSpend.unmatched.spendUsd,
        adUnmatchedSpendKrw: adSpend.unmatched.hasMissingExchangeRate ? null : adSpend.unmatched.spendKrw,
        missingExchangeRateDates: Array.from(adSpend.missingExchangeRateDates).sort(),
        ...summarizeCouponResolutions(couponAggregation.resolutions)
      }
    };
  }

  async couponMatches(query: { from?: string; to?: string; status?: string }) {
    const range = parseDateRange(query.from, query.to);
    const status = parseOptionalCouponMatchFilter(query.status);
    const salesData = await this.cafe24SalesLines(range);
    const salesLines = salesData.salesLines;
    const productIds = uniqueNonEmpty(salesLines.map(activeLineProductId));
    const couponRules = await this.findCouponRules(range, productIds);
    const { resolutions } = this.resolveCouponOrders(salesData.couponLines, couponRules);
    const linesByOrderNo = groupBy(salesData.couponLines, (line) => line.orderNo);

    return {
      period: { from: range.from, to: range.to },
      rows: resolutions
        .filter((resolution) => resolution.couponDetected && couponResolutionMatchesFilter(resolution, status))
        .map((resolution) => {
          const orderLines = linesByOrderNo.get(resolution.orderNo) ?? [];
          const products = uniqueCouponAuditProducts(orderLines);
          const paymentMethod = uniqueNonEmpty(orderLines.map((line) => line.paymentMethod)).join(" / ") || null;
          return {
            orderNo: resolution.orderNo,
            orderDate: resolution.orderDate ? formatDateOnly(resolution.orderDate) : null,
            productIds: products.map((product) => product.productId).filter((id): id is string => Boolean(id)),
            productNames: products.map((product) => product.productName),
            products,
            paymentMethod,
            totalOrderKrw: resolution.totalOrderKrw,
            totalPaidKrw: resolution.totalPaidKrw,
            observedGapKrw: resolution.observedGapKrw,
            selectedRuleId: resolution.selectedRuleId,
            selectedRuleName: resolution.selectedRuleName,
            selectedScope: resolution.selectedScope,
            couponDeductionKrw: resolution.couponDeductionKrw,
            ignoredResidualKrw: resolution.ignoredResidualKrw,
            status: resolution.status,
            confidence: resolution.confidence,
            warningCodes: resolution.warningCodes,
            candidateRuleIds: resolution.candidateRuleIds
          };
        })
    };
  }

  async unmatchedCafe24Lines(query: { from?: string; to?: string; take?: string }) {
    const range = parseDateRange(query.from, query.to);
    const take = Math.min(Math.max(Number(query.take ?? 100) || 100, 1), 500);
    const completeCafe24BatchIds = await this.completeCafe24BatchIds(range);
    return completeCafe24BatchIds.length > 0
      ? this.prisma.cafe24OrderLine.findMany({
          where: {
            isCurrent: true,
            uploadBatchId: { in: completeCafe24BatchIds },
            orderDate: { gte: range.fromDate, lte: range.toDate },
            productId: null,
            validationStatus: { not: RowValidationStatus.ERROR }
          },
          take,
          orderBy: [{ orderDate: "desc" }, { rowNumber: "asc" }],
          include: { batch: true }
        })
      : [];
  }

  private async cafe24SalesLines(range: ReturnType<typeof parseDateRange>) {
    const completeCafe24BatchIds = await this.completeCafe24BatchIds(range);
    if (completeCafe24BatchIds.length === 0) {
      return { salesLines: [] as Cafe24Line[], couponLines: [] as Cafe24Line[] };
    }
    const salesLines = await this.prisma.cafe24OrderLine.findMany({
      where: {
        isCurrent: true,
        uploadBatchId: { in: completeCafe24BatchIds },
        orderDate: { gte: range.fromDate, lte: range.toDate },
        validationStatus: { not: RowValidationStatus.ERROR }
      },
      include: { product: true, matchRule: true },
      orderBy: [{ orderDate: "asc" }, { rowNumber: "asc" }]
    });
    if (salesLines.length === 0) {
      return { salesLines, couponLines: salesLines };
    }

    const currentOrderBatchKeys = new Set(salesLines.map((line) => orderBatchKey(line.uploadBatchId, line.orderNo)));
    const siblingCandidates = await this.prisma.cafe24OrderLine.findMany({
      where: {
        uploadBatchId: { in: uniqueNonEmpty(salesLines.map((line) => line.uploadBatchId)) },
        OR: [
          { isCurrent: true },
          { validationStatus: RowValidationStatus.ERROR }
        ]
      },
      include: { product: true, matchRule: true },
      orderBy: [{ orderDate: "asc" }, { rowNumber: "asc" }]
    });
    const couponLines = siblingCandidates.filter((line) =>
      currentOrderBatchKeys.has(orderBatchKey(line.uploadBatchId, line.orderNo))
    );
    return { salesLines, couponLines };
  }

  private async findCouponRules(
    range: ReturnType<typeof parseDateRange>,
    productIds: string[]
  ): Promise<CouponRule[]> {
    if (productIds.length === 0) {
      return [];
    }
    return this.prisma.cafe24CouponRule.findMany({
      where: {
        isActive: true,
        validFrom: { lte: range.toDate },
        AND: [
          {
            OR: [{ validTo: null }, { validTo: { gte: range.fromDate } }]
          },
          {
            OR: [{ scope: "GLOBAL" }, { scope: "PRODUCT", productId: { in: productIds } }]
          }
        ]
      },
      orderBy: [{ priority: "asc" }, { validFrom: "desc" }, { createdAt: "desc" }]
    });
  }

  private resolveCouponOrders(lines: Cafe24Line[], rules: CouponRule[]) {
    const resolutions: Cafe24CouponResolution[] = [];
    const byProductId = new Map<string, CouponProductAccumulator>();
    const ruleInputs = rules.map(couponRuleInput);

    for (const [orderNo, orderLines] of groupBy(lines, (line) => line.orderNo)) {
      const resolution = resolveCafe24CouponOrder({
        orderNo,
        lines: orderLines.map((line) => ({
          orderDate: line.orderDate,
          paymentMethod: line.paymentMethod,
          totalOrderKrw: nullableNumber(line.totalOrderKrw),
          totalPaidKrw: nullableNumber(line.totalPaidKrw),
          productId: activeLineProductId(line),
          salePriceKrw: numberFrom(line.salePriceKrw),
          quantity: numberFrom(line.quantity),
          isValid: line.validationStatus !== RowValidationStatus.ERROR
        })),
        rules: ruleInputs
      });
      resolutions.push(resolution);

      if (resolution.status === "APPLIED") {
        const residualAllocations =
          allocateNonNegativeByWeight(resolution.ignoredResidualKrw, resolution.allocationsByProductId) ??
          new Map<string, number>();
        for (const [productId, deductionKrw] of resolution.allocationsByProductId) {
          const accumulator = byProductId.get(productId) ?? emptyCouponProductAccumulator();
          accumulator.couponDeductionKrw += deductionKrw;
          accumulator.appliedOrderNos.add(orderNo);
          if (resolution.confidence === "EXACT") {
            accumulator.exactOrderNos.add(orderNo);
          } else if (resolution.confidence === "ESTIMATED") {
            accumulator.estimatedOrderNos.add(orderNo);
          }
          accumulator.couponIgnoredResidualKrw += residualAllocations.get(productId) ?? 0;
          byProductId.set(productId, accumulator);
        }
      } else if (resolution.status === "UNMATCHED") {
        for (const productId of uniqueNonEmpty(orderLines.map(activeLineProductId))) {
          const accumulator = byProductId.get(productId) ?? emptyCouponProductAccumulator();
          accumulator.unmatchedOrderNos.add(orderNo);
          byProductId.set(productId, accumulator);
        }
      }
    }

    return { resolutions, byProductId };
  }

  private async completeCafe24BatchIds(range: ReturnType<typeof parseDateRange>) {
    const batches = await this.prisma.cafe24UploadBatch.findMany({
      where: {
        status: { in: [UploadStatus.IMPORTED, UploadStatus.PARTIAL] },
        OR: [
          { orderStart: null },
          { orderEnd: null },
          { orderStart: { lte: range.toDate }, orderEnd: { gte: range.fromDate } }
        ]
      },
      select: {
        id: true,
        rowCount: true,
        _count: { select: { rows: true } }
      }
    });
    return batches
      .filter((batch) => isCompleteCafe24UploadBatch({ rowCount: batch.rowCount, storedRowCount: batch._count.rows }))
      .map((batch) => batch.id);
  }

  private aggregateSales(
    lines: Cafe24Line[],
    costRulesByProductId: Map<string, CostRule[]>,
    fallbackDate: Date,
    couponsByProductId: Map<string, CouponProductAccumulator>
  ) {
    const groups = new Map<string, SalesAccumulator>();
    for (const line of lines) {
      const productId = activeLineProductId(line);
      if (!productId) {
        continue;
      }
      const accumulator = groups.get(productId) ?? emptySalesAccumulator(line.product);
      const orderQuantity = numberFrom(line.quantity);
      const salesQuantity = orderQuantity * salesUnitMultiplier(line.matchRule);
      const calculationQuantity = isBundleRule(line.matchRule) ? orderQuantity : salesQuantity;
      const lineDate = line.orderDate ?? fallbackDate;
      const costRule = findRuleForDate(costRulesByProductId.get(productId) ?? [], lineDate);
      accumulator.quantity += salesQuantity;
      accumulator.totalPaidKrw += numberFrom(line.totalPaidKrw);
      accumulator.lineCount += 1;

      if (!costRule) {
        accumulator.revenueKrw += fallbackRevenueKrw(line, orderQuantity, salesQuantity);
        accumulator.missingCostRule = true;
        groups.set(productId, accumulator);
        continue;
      }

      const resolvedCost = this.calculator.resolveCost(
        {
          salePriceKrw: numberFrom(costRule.salePriceKrw),
          vatKrw: numberFrom(costRule.vatKrw),
          productCostKrw: numberFrom(costRule.productCostKrw),
          shippingKrw: numberFrom(costRule.shippingKrw),
          extraCostKrw: numberFrom(costRule.extraCostKrw)
        },
        line.matchRule
          ? {
              salePriceKrwOverride: nullableNumber(line.matchRule.salePriceKrwOverride),
              productCostKrwOverride: nullableNumber(line.matchRule.productCostKrwOverride),
              shippingKrwOverride: nullableNumber(line.matchRule.shippingKrwOverride),
              extraCostKrwOverride: nullableNumber(line.matchRule.extraCostKrwOverride)
            }
          : null
      );
      const calculated = this.calculator.calculate({
        quantity: calculationQuantity,
        adSpendUsd: 0,
        exchangeRateKrwPerUsd: 0,
        cost: resolvedCost
      });
      accumulator.revenueKrw += calculated.revenueKrw;
      accumulator.grossCostKrw += calculated.grossCostKrw;
      if (!isBundleRule(line.matchRule) && Math.abs(numberFrom(line.salePriceKrw) - resolvedCost.salePriceKrw) >= 1) {
        accumulator.priceMismatchCount += 1;
      }
      groups.set(productId, accumulator);
    }

    for (const [productId, coupon] of couponsByProductId) {
      const accumulator = groups.get(productId);
      if (!accumulator) {
        continue;
      }
      accumulator.couponDeductionKrw = coupon.couponDeductionKrw;
      accumulator.couponOrderCount = coupon.appliedOrderNos.size;
      accumulator.couponExactOrderCount = coupon.exactOrderNos.size;
      accumulator.couponEstimatedOrderCount = coupon.estimatedOrderNos.size;
      accumulator.couponUnmatchedOrderCount = coupon.unmatchedOrderNos.size;
      accumulator.couponIgnoredResidualKrw = coupon.couponIgnoredResidualKrw;
    }
    return groups;
  }

  private aggregateAdSpend(
    metrics: AdMetric[],
    costRulesByProductId: Map<string, CostRule[]>,
    exchangeRateByDate: Map<string, ExchangeRateRow>
  ) {
    const byProductId = new Map<string, AdAccumulator>();
    const unmatched = emptyAdAccumulator();
    const missingExchangeRateDates = new Set<string>();

    for (const metric of metrics) {
      const spendUsd = numberFrom(metric.spendUsd);
      const productId = activeMetricProductId(metric);
      const target = productId ? byProductId.get(productId) ?? emptyAdAccumulator(metric.product) : unmatched;
      target.spendUsd += spendUsd;
      target.metricCount += 1;

      const metricDate = formatDateOnly(metric.metricDate);
      const exchangeRate = exchangeRateByDate.get(metricDate);
      const costRule = productId ? findRuleForDate(costRulesByProductId.get(productId) ?? [], metric.metricDate) : null;
      const legacyExchangeRate = costRule ? numberFrom(costRule.fxRateKrwPerUsd) : 0;
      const exchangeRateKrwPerUsd = exchangeRate ? numberFrom(exchangeRate.rate) : legacyExchangeRate > 0 ? legacyExchangeRate : null;
      if (exchangeRateKrwPerUsd === null && spendUsd > 0) {
        target.hasMissingExchangeRate = true;
        missingExchangeRateDates.add(metricDate);
      } else if (exchangeRateKrwPerUsd !== null) {
        target.spendKrw += spendUsd * exchangeRateKrwPerUsd;
      }

      if (productId) {
        byProductId.set(productId, target);
      }
    }

    return { byProductId, unmatched, missingExchangeRateDates };
  }
}

type SalesAccumulator = {
  product: ProductSnapshot;
  quantity: number;
  revenueKrw: number;
  totalPaidKrw: number;
  grossCostKrw: number;
  lineCount: number;
  priceMismatchCount: number;
  missingCostRule: boolean;
  couponDeductionKrw: number;
  couponOrderCount: number;
  couponExactOrderCount: number;
  couponEstimatedOrderCount: number;
  couponUnmatchedOrderCount: number;
  couponIgnoredResidualKrw: number;
};

type CouponProductAccumulator = {
  couponDeductionKrw: number;
  couponIgnoredResidualKrw: number;
  appliedOrderNos: Set<string>;
  exactOrderNos: Set<string>;
  estimatedOrderNos: Set<string>;
  unmatchedOrderNos: Set<string>;
};

type AdAccumulator = {
  product: ProductSnapshot;
  spendUsd: number;
  spendKrw: number;
  metricCount: number;
  hasMissingExchangeRate: boolean;
};

function emptySalesAccumulator(product: ProductSnapshot = null): SalesAccumulator {
  return {
    product,
    quantity: 0,
    revenueKrw: 0,
    totalPaidKrw: 0,
    grossCostKrw: 0,
    lineCount: 0,
    priceMismatchCount: 0,
    missingCostRule: false,
    couponDeductionKrw: 0,
    couponOrderCount: 0,
    couponExactOrderCount: 0,
    couponEstimatedOrderCount: 0,
    couponUnmatchedOrderCount: 0,
    couponIgnoredResidualKrw: 0
  };
}

function emptyCouponProductAccumulator(): CouponProductAccumulator {
  return {
    couponDeductionKrw: 0,
    couponIgnoredResidualKrw: 0,
    appliedOrderNos: new Set(),
    exactOrderNos: new Set(),
    estimatedOrderNos: new Set(),
    unmatchedOrderNos: new Set()
  };
}

function emptyAdAccumulator(product: ProductSnapshot = null): AdAccumulator {
  return {
    product,
    spendUsd: 0,
    spendKrw: 0,
    metricCount: 0,
    hasMissingExchangeRate: false
  };
}

function summarizeRuleStatus(sales: SalesAccumulator, ads: AdAccumulator): RuleStatus {
  if (sales.missingCostRule && ads.hasMissingExchangeRate) {
    return "MISSING_RULES";
  }
  if (sales.missingCostRule) {
    return "MISSING_COST_RULE";
  }
  if (ads.hasMissingExchangeRate) {
    return "MISSING_EXCHANGE_RATE";
  }
  if (sales.priceMismatchCount > 0) {
    return "PRICE_MISMATCH";
  }
  return "OK";
}

function summarizeCouponStatus(sales: SalesAccumulator): CouponAggregateStatus {
  const statuses = [
    sales.couponExactOrderCount > 0 ? "EXACT" : null,
    sales.couponEstimatedOrderCount > 0 ? "ESTIMATED" : null,
    sales.couponUnmatchedOrderCount > 0 ? "UNMATCHED" : null
  ].filter((status): status is Exclude<CouponAggregateStatus, "NO_COUPON" | "MIXED"> => status !== null);
  if (statuses.length === 0) {
    return "NO_COUPON";
  }
  return statuses.length === 1 ? statuses[0] : "MIXED";
}

function summarizeCouponResolutions(resolutions: Cafe24CouponResolution[]) {
  const detected = resolutions.filter((resolution) => resolution.couponDetected);
  const applied = detected.filter((resolution) => resolution.status === "APPLIED");
  return {
    couponDetectedOrderCount: detected.length,
    couponAppliedOrderCount: applied.length,
    couponExactOrderCount: applied.filter((resolution) => resolution.confidence === "EXACT").length,
    couponEstimatedOrderCount: applied.filter((resolution) => resolution.confidence === "ESTIMATED").length,
    couponUnmatchedOrderCount: detected.filter((resolution) => resolution.status === "UNMATCHED").length,
    couponDeductionKrw: applied.reduce((total, resolution) => total + resolution.couponDeductionKrw, 0),
    couponIgnoredResidualKrw: applied.reduce((total, resolution) => total + resolution.ignoredResidualKrw, 0),
    couponMissingTotalOrderCount: detected.filter((resolution) =>
      resolution.warningCodes.includes("MISSING_TOTAL_ORDER")
    ).length
  };
}

function findRuleForDate<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(rules: T[], date: Date): T | null {
  return (
    rules
      .filter((rule) => rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date))
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null
  );
}

function couponRuleInput(rule: CouponRule): Cafe24CouponRuleInput {
  return {
    id: rule.id,
    name: rule.name,
    scope: rule.scope,
    productId: rule.productId,
    discountKrw: numberFrom(rule.discountKrw),
    priority: rule.priority,
    validFrom: rule.validFrom,
    validTo: rule.validTo,
    isActive: rule.isActive,
    createdAt: rule.createdAt
  };
}

function uniqueCouponAuditProducts(lines: Cafe24Line[]) {
  const products = new Map<string, { productId: string | null; productName: string }>();
  for (const line of lines) {
    const productId = line.productId;
    const productName = productLabel(line.product) || line.productName || line.optionName || "(미매칭 상품)";
    const key = productId ?? `unmatched:${productName}`;
    if (!products.has(key)) {
      products.set(key, { productId, productName });
    }
  }
  return Array.from(products.values()).sort((left, right) =>
    `${left.productName}:${left.productId ?? ""}`.localeCompare(`${right.productName}:${right.productId ?? ""}`)
  );
}

function couponResolutionMatchesFilter(
  resolution: Cafe24CouponResolution,
  filter: CouponMatchFilter | null
) {
  if (!filter) {
    return true;
  }
  if (filter === "UNMATCHED") {
    return resolution.status === "UNMATCHED";
  }
  return resolution.status === "APPLIED" && resolution.confidence === filter;
}

function orderBatchKey(uploadBatchId: string, orderNo: string) {
  return `${uploadBatchId}\u0000${orderNo}`;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function productMap(lines: Cafe24Line[], metrics: AdMetric[]) {
  const products = new Map<string, ProductSnapshot>();
  for (const line of lines) {
    const productId = activeLineProductId(line);
    if (productId) {
      products.set(productId, line.product);
    }
  }
  for (const metric of metrics) {
    const productId = activeMetricProductId(metric);
    if (productId) {
      products.set(productId, metric.product);
    }
  }
  return products;
}

function activeLineProductId(line: { productId: string | null; product: ProductSnapshot }) {
  return line.productId && isActiveProduct(line.product) ? line.productId : null;
}

function activeMetricProductId(metric: { productId: string | null; product: ProductSnapshot }) {
  return metric.productId && isActiveProduct(metric.product) ? metric.productId : null;
}

function isActiveProduct(product: ProductSnapshot | undefined) {
  return Boolean(product) && product?.isActive !== false;
}

function salesUnitMultiplier(matchRule: Cafe24Line["matchRule"] | null) {
  return isBundleRule(matchRule) ? 2 : 1;
}

function isBundleRule(matchRule: Cafe24Line["matchRule"] | null) {
  if (!matchRule) {
    return false;
  }
  const labels = [
    matchRule.displayName,
    ...stringArrayFromJson(matchRule.optionIncludeKeywords),
    ...stringArrayFromJson(matchRule.productNameAliases)
  ].map(normalizeRuleText);
  return labels.some((label) => label.includes("1+1")) || stringArrayFromJson(matchRule.optionIncludeKeywords).includes("+");
}

function fallbackRevenueKrw(line: Cafe24Line, orderQuantity: number, salesQuantity: number) {
  const salePriceOverride = nullableNumber(line.matchRule?.salePriceKrwOverride);
  if (salePriceOverride !== null) {
    return salePriceOverride * (isBundleRule(line.matchRule) ? orderQuantity : salesQuantity);
  }
  return numberFrom(line.salePriceKrw) * salesQuantity;
}

function stringArrayFromJson(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function normalizeRuleText(value: string | null | undefined) {
  return String(value ?? "")
    .split(/\s+/)
    .join("")
    .toLowerCase();
}

function productLabel(product: ProductSnapshot | undefined) {
  return product?.displayName ?? product?.name ?? product?.code ?? "";
}

function nullableNumber(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return numberFrom(value);
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function parseOptionalDeliveryStatusFilter(value?: string) {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "active" || normalized === "inactive" || normalized === "all") {
    return normalized;
  }
  throw new BadRequestException({
    code: "INVALID_DELIVERY_STATUS",
    message: "deliveryStatus must be active, inactive, or all."
  });
}

function parseOptionalCouponMatchFilter(value?: string): CouponMatchFilter | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === "EXACT" || normalized === "ESTIMATED" || normalized === "UNMATCHED") {
    return normalized;
  }
  throw new BadRequestException({
    code: "INVALID_COUPON_MATCH_STATUS",
    message: "status must be EXACT, ESTIMATED, or UNMATCHED."
  });
}

function deliveryStatusWhere(filter: "active" | "inactive" | "all" | null): Prisma.MetaAdsetDailyMetricWhereInput {
  if (!filter || filter === "all") {
    return {};
  }
  return { deliveryStatus: { equals: filter, mode: "insensitive" } };
}
