import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma, RowValidationStatus, UploadStatus } from "@prisma/client";
import { numberFrom, parseDateRange } from "../common/date-range";
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

@Injectable()
export class SalesMetricsService {
  private readonly calculator = new Cafe24SalesCalculator();

  constructor(private readonly prisma: PrismaService) {}

  async productPerformance(query: { from?: string; to?: string; deliveryStatus?: string }) {
    const range = parseDateRange(query.from, query.to);
    const deliveryStatus = parseOptionalDeliveryStatusFilter(query.deliveryStatus);
    const [completeCafe24BatchIds, adMetrics] = await Promise.all([
      this.completeCafe24BatchIds(range),
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
    const salesLines =
      completeCafe24BatchIds.length > 0
        ? await this.prisma.cafe24OrderLine.findMany({
            where: {
              isCurrent: true,
              uploadBatchId: { in: completeCafe24BatchIds },
              orderDate: { gte: range.fromDate, lte: range.toDate },
              validationStatus: { not: RowValidationStatus.ERROR }
            },
            include: { product: true, matchRule: true },
            orderBy: [{ orderDate: "asc" }, { rowNumber: "asc" }]
          })
        : [];

    const productIds = uniqueNonEmpty([
      ...salesLines.map(activeLineProductId),
      ...adMetrics.map(activeMetricProductId)
    ]);
    const metricDates = uniqueNonEmpty(adMetrics.map((metric) => formatDateOnly(metric.metricDate)));
    const [costRules, exchangeRates] = await Promise.all([
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
        : Promise.resolve([] as ExchangeRateRow[])
    ]);

    const costRulesByProductId = groupBy(costRules, (rule) => rule.productId);
    const exchangeRateByDate = new Map(exchangeRates.map((rate) => [formatDateOnly(rate.rateDate), rate]));
    const salesByProductId = this.aggregateSales(salesLines, costRulesByProductId, range.fromDate);
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
      const totalCostKrw = adSpendKrw === null || grossCostKrw === null ? null : grossCostKrw + adSpendKrw;
      const marginKrw = totalCostKrw === null ? null : sales.revenueKrw - totalCostKrw;
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
        missingExchangeRateDates: Array.from(adSpend.missingExchangeRateDates).sort()
      }
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

  private aggregateSales(lines: Cafe24Line[], costRulesByProductId: Map<string, CostRule[]>, fallbackDate: Date) {
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
    missingCostRule: false
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

function findRuleForDate<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(rules: T[], date: Date): T | null {
  return (
    rules
      .filter((rule) => rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date))
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null
  );
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
  if (value === null) {
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

function deliveryStatusWhere(filter: "active" | "inactive" | "all" | null): Prisma.MetaAdsetDailyMetricWhereInput {
  if (!filter || filter === "all") {
    return {};
  }
  return { deliveryStatus: { equals: filter, mode: "insensitive" } };
}
