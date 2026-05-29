import { Module } from "@nestjs/common";
import { ExchangeRatesService } from "./exchange-rates.service";
import { KoreaEximExchangeRateProvider } from "./exchange-rate-provider";

@Module({
  providers: [ExchangeRatesService, KoreaEximExchangeRateProvider],
  exports: [ExchangeRatesService]
})
export class ExchangeRatesModule {}
