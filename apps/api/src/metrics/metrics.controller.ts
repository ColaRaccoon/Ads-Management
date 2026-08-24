import { Controller, Get, Param, Query } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { RequirePermissions } from "../auth/route-decorators";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get("campaigns")
  @RequirePermissions("data.read")
  campaigns(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("productId") productId?: string,
    @Query("stage") stage?: string,
    @Query("deliveryStatus") deliveryStatus?: string
  ) {
    return this.metricsService.campaignMetrics({ from, to, productId, stage, deliveryStatus });
  }

  @Get("adsets")
  @RequirePermissions("data.read")
  adsets(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("campaignId") campaignId?: string,
    @Query("productId") productId?: string,
    @Query("stage") stage?: string,
    @Query("decision") decision?: string,
    @Query("deliveryStatus") deliveryStatus?: string
  ) {
    return this.metricsService.adsetMetrics({ from, to, campaignId, productId, stage, decision, deliveryStatus });
  }

  @Get("adsets/:metaAdsetId/ads")
  @RequirePermissions("data.read")
  adsetAds(
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Query("deliveryStatus") deliveryStatus: string | undefined,
    @Param("metaAdsetId") metaAdsetId: string
  ) {
    return this.metricsService.adsForAdset(metaAdsetId, from, to, deliveryStatus);
  }

  @Get("campaigns/:metaCampaignId/adsets")
  @RequirePermissions("data.read")
  campaignAdsets(
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Query("deliveryStatus") deliveryStatus: string | undefined,
    @Param("metaCampaignId") metaCampaignId: string
  ) {
    return this.metricsService.adsetsForCampaign(metaCampaignId, from, to, deliveryStatus);
  }

  @Get("ads/compare-by-name")
  @RequirePermissions("data.read")
  compareAdsByName(
    @Query("adName") adName?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("deliveryStatus") deliveryStatus?: string
  ) {
    return this.metricsService.compareAdsByName(adName, from, to, deliveryStatus);
  }

  @Get("ads/creatives")
  @RequirePermissions("data.read")
  creativeAds(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("campaignId") campaignId?: string,
    @Query("adsetId") adsetId?: string,
    @Query("productId") productId?: string,
    @Query("stage") stage?: string,
    @Query("deliveryStatus") deliveryStatus?: string,
    @Query("q") q?: string
  ) {
    return this.metricsService.creativeMetrics({ from, to, campaignId, adsetId, productId, stage, deliveryStatus, q });
  }

  @Get("ads/creative-video-trends")
  @RequirePermissions("data.read")
  creativeVideoTrends(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("productId") productId?: string,
    @Query("deliveryStatus") deliveryStatus?: string
  ) {
    return this.metricsService.creativeVideoTrends({ from, to, productId, deliveryStatus });
  }

  @Get("ads")
  @RequirePermissions("data.read")
  ads(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("campaignId") campaignId?: string,
    @Query("adsetId") adsetId?: string,
    @Query("productId") productId?: string,
    @Query("stage") stage?: string,
    @Query("deliveryStatus") deliveryStatus?: string
  ) {
    return this.metricsService.adMetrics({ from, to, campaignId, adsetId, productId, stage, deliveryStatus });
  }

  @Get("products")
  @RequirePermissions("data.read")
  products(@Query("from") from?: string, @Query("to") to?: string, @Query("deliveryStatus") deliveryStatus?: string) {
    return this.metricsService.productMetrics(from, to, deliveryStatus);
  }

  @Get("unmatched")
  @RequirePermissions("data.read")
  unmatched(@Query("from") from?: string, @Query("to") to?: string, @Query("deliveryStatus") deliveryStatus?: string) {
    return this.metricsService.unmatchedMetrics(from, to, deliveryStatus);
  }
}
