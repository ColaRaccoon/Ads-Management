import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExchangeRate, ExchangeRateFallbackType, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { formatDateOnly, toDateOnly } from "../domain/date-number";
import { KOREA_EXIM_PROVIDER, KoreaEximExchangeRateProvider, ProviderRate } from "./exchange-rate-provider";

const BASE_CURRENCY = "USD";
const QUOTE_CURRENCY = "KRW";

@Injectable()
export class ExchangeRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: KoreaEximExchangeRateProvider,
    private readonly config: ConfigService
  ) {}

  async ensureUsdKrwRatesForDates(dates: Date[]): Promise<Map<string, ExchangeRate>> {
    const uniqueDates = Array.from(new Set(dates.map((date) => formatDateOnly(date)))).sort();
    const rates = new Map<string, ExchangeRate>();

    for (const dateKey of uniqueDates) {
      const date = toDateOnly(dateKey);
      if (!date) {
        continue;
      }
      rates.set(dateKey, await this.getUsdKrwRateForDate(date));
    }

    return rates;
  }

  async getUsdKrwRateForDate(date: Date): Promise<ExchangeRate> {
    const rateDate = normalizeDateOnly(date);
    const existing = await this.findStoredRateForDate(rateDate);
    if (existing) {
      return existing;
    }

    let providerError: unknown = null;
    try {
      const exactRate = await this.fetchExactRateFromProvider(rateDate);
      if (exactRate) {
        return this.upsertProviderRate(rateDate, exactRate, ExchangeRateFallbackType.EXACT);
      }
    } catch (error) {
      providerError = error;
    }

    if (providerError) {
      const latestStoredFallback = await this.findLatestStoredRate();
      if (latestStoredFallback) {
        return this.upsertStoredFallbackRate(rateDate, latestStoredFallback, providerError);
      }
      throw exchangeRateUnavailable(rateDate, providerError);
    }

    try {
      const lookbackRate = await this.fetchPreviousRateFromProvider(rateDate);
      if (lookbackRate) {
        return this.upsertProviderRate(rateDate, lookbackRate, ExchangeRateFallbackType.PREVIOUS_AVAILABLE);
      }
    } catch (error) {
      providerError = error;
      const latestStoredFallback = await this.findLatestStoredRate();
      if (latestStoredFallback) {
        return this.upsertStoredFallbackRate(rateDate, latestStoredFallback, providerError);
      }
      throw exchangeRateUnavailable(rateDate, providerError);
    }

    const storedFallback = await this.findLatestStoredRateOnOrBefore(rateDate);
    if (storedFallback) {
      return this.upsertStoredFallbackRate(rateDate, storedFallback, null);
    }

    try {
      const latestRate = await this.fetchLatestRateFromProvider();
      if (latestRate) {
        return this.upsertProviderRate(rateDate, latestRate, ExchangeRateFallbackType.LATEST_AVAILABLE);
      }
    } catch (error) {
      providerError = error;
      const latestStoredFallback = await this.findLatestStoredRate();
      if (latestStoredFallback) {
        return this.upsertStoredFallbackRate(rateDate, latestStoredFallback, providerError);
      }
    }

    throw exchangeRateUnavailable(rateDate, providerError);
  }

  async findLatestStoredRateOnOrBefore(date: Date): Promise<ExchangeRate | null> {
    const rateDate = normalizeDateOnly(date);
    return this.prisma.exchangeRate.findFirst({
      where: {
        baseCurrency: BASE_CURRENCY,
        quoteCurrency: QUOTE_CURRENCY,
        provider: KOREA_EXIM_PROVIDER,
        sourceDate: { lte: rateDate }
      },
      orderBy: [{ sourceDate: "desc" }, { rateDate: "desc" }]
    });
  }

  private async findLatestStoredRate(): Promise<ExchangeRate | null> {
    return this.prisma.exchangeRate.findFirst({
      where: {
        baseCurrency: BASE_CURRENCY,
        quoteCurrency: QUOTE_CURRENCY,
        provider: KOREA_EXIM_PROVIDER
      },
      orderBy: [{ sourceDate: "desc" }, { rateDate: "desc" }]
    });
  }

  fetchExactRateFromProvider(date: Date): Promise<ProviderRate | null> {
    return this.provider.fetchRate(normalizeDateOnly(date));
  }

  fetchLatestRateFromProvider(): Promise<ProviderRate | null> {
    return this.provider.fetchLatestRate();
  }

  private async findStoredRateForDate(date: Date): Promise<ExchangeRate | null> {
    return this.prisma.exchangeRate.findUnique({
      where: {
        rateDate_baseCurrency_quoteCurrency_provider: {
          rateDate: normalizeDateOnly(date),
          baseCurrency: BASE_CURRENCY,
          quoteCurrency: QUOTE_CURRENCY,
          provider: KOREA_EXIM_PROVIDER
        }
      }
    });
  }

  private async fetchPreviousRateFromProvider(date: Date): Promise<ProviderRate | null> {
    const lookbackDays = configNumber(this.config.get<string>("EXCHANGE_RATE_LOOKBACK_DAYS"), 10);
    const rateDate = normalizeDateOnly(date);
    let providerError: unknown = null;

    for (let daysAgo = 1; daysAgo <= lookbackDays; daysAgo += 1) {
      try {
        const rate = await this.provider.fetchRate(addDays(rateDate, -daysAgo));
        if (rate) {
          return rate;
        }
      } catch (error) {
        providerError = error;
        break;
      }
    }

    if (providerError) {
      throw providerError;
    }
    return null;
  }

  private upsertProviderRate(
    rateDate: Date,
    providerRate: ProviderRate,
    fallbackType: ExchangeRateFallbackType
  ): Promise<ExchangeRate> {
    const normalizedRateDate = normalizeDateOnly(rateDate);
    const data = {
      rateDate: normalizedRateDate,
      sourceDate: normalizeDateOnly(providerRate.date),
      baseCurrency: BASE_CURRENCY,
      quoteCurrency: QUOTE_CURRENCY,
      rate: new Prisma.Decimal(providerRate.rate),
      provider: providerRate.provider,
      providerPayload: jsonInput(providerRate.rawPayload),
      fallbackType,
      fetchedAt: new Date()
    };

    return this.prisma.exchangeRate.upsert({
      where: {
        rateDate_baseCurrency_quoteCurrency_provider: {
          rateDate: normalizedRateDate,
          baseCurrency: BASE_CURRENCY,
          quoteCurrency: QUOTE_CURRENCY,
          provider: providerRate.provider
        }
      },
      create: data,
      update: {
        sourceDate: data.sourceDate,
        rate: data.rate,
        providerPayload: data.providerPayload,
        fallbackType,
        fetchedAt: data.fetchedAt
      }
    });
  }

  private upsertStoredFallbackRate(
    rateDate: Date,
    storedFallback: ExchangeRate,
    providerError: unknown
  ): Promise<ExchangeRate> {
    const normalizedRateDate = normalizeDateOnly(rateDate);
    const fallbackType =
      normalizeDateOnly(storedFallback.sourceDate) <= normalizedRateDate
        ? ExchangeRateFallbackType.PREVIOUS_AVAILABLE
        : ExchangeRateFallbackType.LATEST_AVAILABLE;
    const data = {
      rateDate: normalizedRateDate,
      sourceDate: normalizeDateOnly(storedFallback.sourceDate),
      baseCurrency: BASE_CURRENCY,
      quoteCurrency: QUOTE_CURRENCY,
      rate: storedFallback.rate,
      provider: storedFallback.provider,
      providerPayload: jsonInput({
        fallbackFromExchangeRateId: storedFallback.id,
        fallbackFromRateDate: formatDateOnly(storedFallback.rateDate),
        fallbackFromSourceDate: formatDateOnly(storedFallback.sourceDate),
        reason: providerError ? "PROVIDER_ERROR" : "PREVIOUS_STORED_RATE"
      }),
      fallbackType,
      fetchedAt: new Date()
    };

    return this.prisma.exchangeRate.upsert({
      where: {
        rateDate_baseCurrency_quoteCurrency_provider: {
          rateDate: normalizedRateDate,
          baseCurrency: BASE_CURRENCY,
          quoteCurrency: QUOTE_CURRENCY,
          provider: storedFallback.provider
        }
      },
      create: data,
      update: {
        sourceDate: data.sourceDate,
        rate: data.rate,
        providerPayload: data.providerPayload,
        fallbackType: data.fallbackType,
        fetchedAt: data.fetchedAt
      }
    });
  }
}

function normalizeDateOnly(date: Date) {
  return toDateOnly(formatDateOnly(date)) ?? date;
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000);
}

function configNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) {
    return Prisma.JsonNull;
  }
  return value as Prisma.InputJsonValue;
}

function exchangeRateUnavailable(date: Date, cause: unknown) {
  return new BadRequestException({
    code: "EXCHANGE_RATE_UNAVAILABLE",
    message: `${formatDateOnly(date)} USD/KRW 환율을 확보하지 못했습니다.`,
    details: cause instanceof Error ? cause.message : undefined
  });
}
