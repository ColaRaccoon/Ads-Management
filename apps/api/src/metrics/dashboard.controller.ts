import { Controller, Get, Query } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { RequirePermissions } from "../auth/route-decorators";
import { DashboardSummaryQueryDto, DashboardTrendsQueryDto } from "./dto/metrics-query.dto";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get("summary")
  @RequirePermissions("data.read")
  summary(@Query() query: DashboardSummaryQueryDto) {
    return this.metricsService.dashboardSummary(query.from, query.to, query.compare, query.deliveryStatus);
  }

  @Get("trends")
  @RequirePermissions("data.read")
  trends(@Query() query: DashboardTrendsQueryDto) {
    return this.metricsService.dashboardTrends(query.from, query.to, query.groupBy ?? "date", query.deliveryStatus);
  }
}
