import { Controller, Get, Query } from "@nestjs/common";
import { SalesMetricsService } from "./sales-metrics.service";

@Controller("sales")
export class SalesMetricsController {
  constructor(private readonly salesMetricsService: SalesMetricsService) {}

  @Get("product-performance")
  productPerformance(@Query("from") from?: string, @Query("to") to?: string) {
    return this.salesMetricsService.productPerformance({ from, to });
  }

  @Get("cafe24/unmatched")
  unmatchedCafe24Lines(@Query("from") from?: string, @Query("to") to?: string, @Query("take") take?: string) {
    return this.salesMetricsService.unmatchedCafe24Lines({ from, to, take });
  }
}
