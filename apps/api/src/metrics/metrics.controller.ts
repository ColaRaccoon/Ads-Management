import { Controller, Get, Query } from "@nestjs/common";
import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get("adsets")
  adsets(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("productId") productId?: string,
    @Query("stage") stage?: string,
    @Query("decision") decision?: string
  ) {
    return this.metricsService.adsetMetrics({ from, to, productId, stage, decision });
  }

  @Get("products")
  products(@Query("from") from?: string, @Query("to") to?: string) {
    return this.metricsService.productMetrics(from, to);
  }

  @Get("unmatched")
  unmatched(@Query("from") from?: string, @Query("to") to?: string) {
    return this.metricsService.unmatchedMetrics(from, to);
  }
}
