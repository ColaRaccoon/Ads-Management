import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { UploadsController } from "./uploads.controller";
import { UploadsService } from "./uploads.service";
import { MappingsModule } from "../mappings/mappings.module";
import { ExchangeRatesModule } from "../exchange-rates/exchange-rates.module";

@Module({
  imports: [MulterModule.register({}), MappingsModule, ExchangeRatesModule],
  controllers: [UploadsController],
  providers: [UploadsService],
  exports: [UploadsService]
})
export class UploadsModule {}
