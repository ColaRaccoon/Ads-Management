import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { ExchangeRatesModule } from "../exchange-rates/exchange-rates.module";
import { Cafe24UploadsController } from "./cafe24-uploads.controller";
import { Cafe24UploadsService } from "./cafe24-uploads.service";
import { SalesMetricsController } from "./sales-metrics.controller";
import { SalesMetricsService } from "./sales-metrics.service";

@Module({
  imports: [MulterModule.register({}), ExchangeRatesModule],
  controllers: [Cafe24UploadsController, SalesMetricsController],
  providers: [Cafe24UploadsService, SalesMetricsService],
  exports: [Cafe24UploadsService, SalesMetricsService]
})
export class SalesModule {}
