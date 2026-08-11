import { Module } from "@nestjs/common";
import { MetricsController } from "./metrics.controller";
import { DashboardController } from "./dashboard.controller";
import { DashboardMetricsService } from "./dashboard-metrics.service";
import { MetaAdMetricsReadService } from "./meta-ad-metrics-read.service";
import { MetaAdsetMetricDecorationService } from "./meta-adset-metric-decoration.service";
import { MetaAdsetMetricsReadService } from "./meta-adset-metrics-read.service";
import { MetricsService } from "./metrics.service";

@Module({
  controllers: [DashboardController, MetricsController],
  providers: [
    MetricsService,
    MetaAdMetricsReadService,
    MetaAdsetMetricsReadService,
    MetaAdsetMetricDecorationService,
    DashboardMetricsService
  ],
  exports: [MetricsService]
})
export class MetricsModule {}
