import { Controller, Get, Query } from "@nestjs/common";
import { MetricsService } from "./metrics.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get("summary")
  summary(@Query("from") from?: string, @Query("to") to?: string, @Query("compare") compare?: string) {
    return this.metricsService.dashboardSummary(from, to, compare);
  }

  @Get("trends")
  trends(@Query("from") from?: string, @Query("to") to?: string, @Query("groupBy") groupBy?: string) {
    return this.metricsService.dashboardTrends(from, to, groupBy ?? "date");
  }
}
