import { Module } from "@nestjs/common";
import { MetricsController } from "./metrics.controller";
import { DashboardController } from "./dashboard.controller";
import { MetricsService } from "./metrics.service";

@Module({
  controllers: [DashboardController, MetricsController],
  providers: [MetricsService],
  exports: [MetricsService]
})
export class MetricsModule {}
