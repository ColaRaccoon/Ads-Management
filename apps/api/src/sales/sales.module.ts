import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { ExchangeRatesModule } from "../exchange-rates/exchange-rates.module";
import { Cafe24CouponRulesController } from "./cafe24-coupon-rules.controller";
import { Cafe24CouponRulesService } from "./cafe24-coupon-rules.service";
import { Cafe24UploadsController } from "./cafe24-uploads.controller";
import { Cafe24UploadsService } from "./cafe24-uploads.service";
import { SalesMetricsController } from "./sales-metrics.controller";
import { SalesMetricsService } from "./sales-metrics.service";

@Module({
  imports: [MulterModule.register({}), ExchangeRatesModule],
  controllers: [Cafe24UploadsController, Cafe24CouponRulesController, SalesMetricsController],
  providers: [Cafe24UploadsService, Cafe24CouponRulesService, SalesMetricsService],
  exports: [Cafe24UploadsService, Cafe24CouponRulesService, SalesMetricsService]
})
export class SalesModule {}
