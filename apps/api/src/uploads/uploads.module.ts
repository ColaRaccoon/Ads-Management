import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { UploadsController } from "./uploads.controller";
import { UploadsService } from "./uploads.service";
import { MappingsModule } from "../mappings/mappings.module";
import { ExchangeRatesModule } from "../exchange-rates/exchange-rates.module";
import { MetaAdDailyImportService } from "./meta-ad-daily-import.service";
import { MetaAdsetAggregateService } from "./meta-adset-aggregate.service";
import { MetaAdsetImportService } from "./meta-adset-import.service";
import { MetaEntityWriterService } from "./meta-entity-writer.service";
import { MetaMetricVersionService } from "./meta-metric-version.service";
import { UploadLifecycleService } from "./upload-lifecycle.service";
import { UploadQueryService } from "./upload-query.service";
import { UploadStorageService } from "./upload-storage.service";
import { UploadExchangeRateService } from "./upload-exchange-rate.service";

@Module({
  imports: [MulterModule.register({}), MappingsModule, ExchangeRatesModule],
  controllers: [UploadsController],
  providers: [
    UploadsService,
    MetaAdDailyImportService,
    MetaAdsetImportService,
    UploadQueryService,
    UploadLifecycleService,
    UploadStorageService,
    UploadExchangeRateService,
    MetaEntityWriterService,
    MetaMetricVersionService,
    MetaAdsetAggregateService
  ],
  exports: [UploadsService]
})
export class UploadsModule {}
