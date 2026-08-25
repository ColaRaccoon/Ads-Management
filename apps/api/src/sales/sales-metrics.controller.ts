import { Controller, Get, Query } from "@nestjs/common";
import { SalesMetricsService } from "./sales-metrics.service";
import { RequirePermissions } from "../auth/route-decorators";
import {
  Cafe24UnmatchedQueryDto,
  CouponMatchesQueryDto,
  ProductPerformanceQueryDto
} from "./dto/sales-transport.dto";

@Controller("sales")
export class SalesMetricsController {
  constructor(private readonly salesMetricsService: SalesMetricsService) {}

  @Get("product-performance")
  @RequirePermissions("data.read")
  productPerformance(@Query() query: ProductPerformanceQueryDto) {
    return this.salesMetricsService.productPerformance(query);
  }

  @Get("cafe24/coupon-matches")
  @RequirePermissions("data.read")
  couponMatches(@Query() query: CouponMatchesQueryDto) {
    return this.salesMetricsService.couponMatches(query);
  }

  @Get("cafe24/unmatched")
  @RequirePermissions("data.read")
  unmatchedCafe24Lines(@Query() query: Cafe24UnmatchedQueryDto) {
    return this.salesMetricsService.unmatchedCafe24Lines({
      from: query.from,
      to: query.to,
      take: query.take === undefined ? undefined : String(query.take)
    });
  }
}
