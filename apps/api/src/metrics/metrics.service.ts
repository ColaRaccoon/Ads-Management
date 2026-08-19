import { Injectable } from "@nestjs/common";
import { DashboardMetricsService } from "./dashboard-metrics.service";
import { MetaAdMetricsReadService } from "./meta-ad-metrics-read.service";
import { MetaAdsetMetricDecorationService } from "./meta-adset-metric-decoration.service";
import { MetaAdsetMetricsReadService } from "./meta-adset-metrics-read.service";
import {
  AdMetricQuery,
  AdsetMetricQuery,
  CampaignMetricQuery,
  CreativeMetricQuery,
  CreativeVideoTrendQuery,
  DecoratedMetric
} from "./metric-types";

export {
  adDeliveryStatusWhere,
  deliveryStatusWhere,
  parseDeliveryStatusFilter,
  type DeliveryStatusFilter
} from "./metric-filters";

@Injectable()
export class MetricsService {
  constructor(
    private readonly adMetricsReadService: MetaAdMetricsReadService,
    private readonly adsetMetricsReadService: MetaAdsetMetricsReadService,
    private readonly dashboardMetricsService: DashboardMetricsService,
    private readonly decorationService: MetaAdsetMetricDecorationService
  ) {}

  dashboardSummary(from?: string, to?: string, compare?: string, deliveryStatusInput?: string) {
    return this.dashboardMetricsService.dashboardSummary(from, to, compare, deliveryStatusInput);
  }

  dashboardTrends(from?: string, to?: string, groupBy = "date", deliveryStatusInput?: string) {
    return this.dashboardMetricsService.dashboardTrends(from, to, groupBy, deliveryStatusInput);
  }

  productMetrics(from?: string, to?: string, deliveryStatusInput?: string) {
    return this.adsetMetricsReadService.productMetrics(from, to, deliveryStatusInput);
  }

  adsetMetrics(query: AdsetMetricQuery) {
    return this.adsetMetricsReadService.adsetMetrics(query);
  }

  campaignMetrics(query: CampaignMetricQuery) {
    return this.adMetricsReadService.campaignMetrics(query);
  }

  adMetrics(query: AdMetricQuery) {
    return this.adMetricsReadService.adMetrics(query);
  }

  creativeMetrics(query: CreativeMetricQuery) {
    return this.adMetricsReadService.creativeMetrics(query);
  }

  creativeVideoTrends(query: CreativeVideoTrendQuery) {
    return this.adMetricsReadService.creativeVideoTrends(query);
  }

  compareAdsByName(adName: string | undefined, from?: string, to?: string, deliveryStatus?: string) {
    return this.adMetricsReadService.compareAdsByName(adName, from, to, deliveryStatus);
  }

  adsForAdset(metaAdsetId: string, from?: string, to?: string, deliveryStatusInput?: string) {
    return this.adMetricsReadService.adsForAdset(metaAdsetId, from, to, deliveryStatusInput);
  }

  adsetsForCampaign(metaCampaignId: string, from?: string, to?: string, deliveryStatusInput?: string) {
    return this.adMetricsReadService.adsetsForCampaign(metaCampaignId, from, to, deliveryStatusInput);
  }

  unmatchedMetrics(from?: string, to?: string, deliveryStatusInput?: string) {
    return this.adsetMetricsReadService.unmatchedMetrics(from, to, deliveryStatusInput);
  }

  decoratedMetrics(fromDate: Date, toDate: Date, deliveryStatusInput?: string) {
    return this.decorationService.decoratedMetrics(fromDate, toDate, deliveryStatusInput);
  }

  aggregate(rows: DecoratedMetric[]) {
    return this.decorationService.aggregate(rows);
  }
}
