import { Controller, Get, Param, Query } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { RequirePermissions } from "../auth/route-decorators";
import {
  AdMetricsQueryDto,
  AdsetMetricsQueryDto,
  CampaignMetricsQueryDto,
  CompareAdsQueryDto,
  CreativeMetricsQueryDto,
  CreativeVideoTrendsQueryDto,
  MetaAdsetParamDto,
  MetaCampaignParamDto,
  MetricDateRangeQueryDto
} from "./dto/metrics-query.dto";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get("campaigns")
  @RequirePermissions("data.read")
  campaigns(@Query() query: CampaignMetricsQueryDto) {
    return this.metricsService.campaignMetrics(query);
  }

  @Get("adsets")
  @RequirePermissions("data.read")
  adsets(@Query() query: AdsetMetricsQueryDto) {
    return this.metricsService.adsetMetrics(query);
  }

  @Get("adsets/:metaAdsetId/ads")
  @RequirePermissions("data.read")
  adsetAds(
    @Query() query: MetricDateRangeQueryDto,
    @Param() params: MetaAdsetParamDto
  ) {
    return this.metricsService.adsForAdset(params.metaAdsetId, query.from, query.to, query.deliveryStatus);
  }

  @Get("campaigns/:metaCampaignId/adsets")
  @RequirePermissions("data.read")
  campaignAdsets(
    @Query() query: MetricDateRangeQueryDto,
    @Param() params: MetaCampaignParamDto
  ) {
    return this.metricsService.adsetsForCampaign(params.metaCampaignId, query.from, query.to, query.deliveryStatus);
  }

  @Get("ads/compare-by-name")
  @RequirePermissions("data.read")
  compareAdsByName(@Query() query: CompareAdsQueryDto) {
    return this.metricsService.compareAdsByName(query.adName, query.from, query.to, query.deliveryStatus);
  }

  @Get("ads/creatives")
  @RequirePermissions("data.read")
  creativeAds(@Query() query: CreativeMetricsQueryDto) {
    return this.metricsService.creativeMetrics(query);
  }

  @Get("ads/creative-video-trends")
  @RequirePermissions("data.read")
  creativeVideoTrends(@Query() query: CreativeVideoTrendsQueryDto) {
    return this.metricsService.creativeVideoTrends(query);
  }

  @Get("ads")
  @RequirePermissions("data.read")
  ads(@Query() query: AdMetricsQueryDto) {
    return this.metricsService.adMetrics(query);
  }

  @Get("products")
  @RequirePermissions("data.read")
  products(@Query() query: MetricDateRangeQueryDto) {
    return this.metricsService.productMetrics(query.from, query.to, query.deliveryStatus);
  }

  @Get("unmatched")
  @RequirePermissions("data.read")
  unmatched(@Query() query: MetricDateRangeQueryDto) {
    return this.metricsService.unmatchedMetrics(query.from, query.to, query.deliveryStatus);
  }
}
