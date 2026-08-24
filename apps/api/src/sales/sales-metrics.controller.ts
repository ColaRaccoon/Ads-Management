import { Controller, Get, Query } from "@nestjs/common";
import { SalesMetricsService } from "./sales-metrics.service";
import { RequirePermissions } from "../auth/route-decorators";

@Controller("sales")
export class SalesMetricsController {
  constructor(private readonly salesMetricsService: SalesMetricsService) {}

  @Get("product-performance")
  @RequirePermissions("data.read")
  productPerformance(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("deliveryStatus") deliveryStatus?: string
  ) {
    return this.salesMetricsService.productPerformance({ from, to, deliveryStatus });
  }

  @Get("cafe24/coupon-matches")
  @RequirePermissions("data.read")
  couponMatches(@Query("from") from?: string, @Query("to") to?: string, @Query("status") status?: string) {
    return this.salesMetricsService.couponMatches({ from, to, status });
  }

  @Get("cafe24/unmatched")
  @RequirePermissions("data.read")
  unmatchedCafe24Lines(@Query("from") from?: string, @Query("to") to?: string, @Query("take") take?: string) {
    return this.salesMetricsService.unmatchedCafe24Lines({ from, to, take });
  }
}
