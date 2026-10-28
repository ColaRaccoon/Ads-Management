import { Module } from "@nestjs/common";
import { UnifiedProductsController, UnifiedRulesController } from "./management.controller";
import { UnifiedManagementRepository } from "./management.repository";
import { UnifiedManagementService } from "./management.service";
import { MetaPerformanceAdapter } from "./adapters/meta.adapter";
import { GooglePerformanceAdapter } from "./adapters/google.adapter";
import { Cafe24PerformanceAdapter } from "./adapters/cafe24.adapter";
import { StorefrontAdaptersService } from "./adapters/storefront-adapters.service";
import { CoupangPerformanceAdapter } from "./adapters/coupang.adapter";

@Module({
  controllers: [UnifiedProductsController, UnifiedRulesController],
  providers: [UnifiedManagementRepository, UnifiedManagementService, MetaPerformanceAdapter, GooglePerformanceAdapter, Cafe24PerformanceAdapter, StorefrontAdaptersService, CoupangPerformanceAdapter],
  exports: [UnifiedManagementRepository, StorefrontAdaptersService, CoupangPerformanceAdapter]
})
export class UnifiedPerformanceModule {}
