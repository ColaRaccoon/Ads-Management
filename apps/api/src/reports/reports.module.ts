import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { MetricsModule } from "../metrics/metrics.module";
import { ReportReconciliationStateService } from "./report-reconciliation-state.service";

@Module({
  imports: [MetricsModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportReconciliationStateService],
  exports: [ReportReconciliationStateService]
})
export class ReportsModule {}
