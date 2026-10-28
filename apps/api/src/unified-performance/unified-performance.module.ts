import { Module } from "@nestjs/common";
import { UnifiedProductsController, UnifiedRulesController } from "./management.controller";
import { UnifiedManagementRepository } from "./management.repository";
import { UnifiedManagementService } from "./management.service";
import { MetaPerformanceAdapter } from "./adapters/meta.adapter";
import { GooglePerformanceAdapter } from "./adapters/google.adapter";
import { Cafe24PerformanceAdapter } from "./adapters/cafe24.adapter";
import { StorefrontAdaptersService } from "./adapters/storefront-adapters.service";
import { CoupangPerformanceAdapter } from "./adapters/coupang.adapter";
import { NaverPerformanceAdapter } from "./adapters/naver.adapter";
import { UnifiedReportController } from "./report.controller";
import { UnifiedReportRepository } from "./report.repository";
import { UnifiedReportService } from "./report.service";
import { UnifiedAggregationRepository } from "./aggregation.repository";

@Module({
  controllers: [UnifiedProductsController, UnifiedRulesController, UnifiedReportController],
  providers: [UnifiedManagementRepository, UnifiedManagementService, MetaPerformanceAdapter, GooglePerformanceAdapter, Cafe24PerformanceAdapter, StorefrontAdaptersService, CoupangPerformanceAdapter, NaverPerformanceAdapter, UnifiedReportRepository, UnifiedReportService, UnifiedAggregationRepository],
  exports: [UnifiedManagementRepository, StorefrontAdaptersService, CoupangPerformanceAdapter, NaverPerformanceAdapter]
})
export class UnifiedPerformanceModule {}
