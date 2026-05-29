import { describe, expect, it } from "vitest";
import { ExchangeRateFallbackType, Prisma } from "@prisma/client";
import { formatDateOnly, toDateOnly } from "../domain/date-number";
import { KOREA_EXIM_PROVIDER, parseKoreaEximUsdKrwRate, ProviderRate } from "./exchange-rate-provider";
import { ExchangeRatesService } from "./exchange-rates.service";

describe("KoreaEximExchangeRateProvider parser", () => {
  it("parses USD deal_bas_r as KRW per USD", () => {
    const parsed = parseKoreaEximUsdKrwRate([
      { cur_unit: "JPY(100)", deal_bas_r: "929.41" },
      { cur_unit: "USD", deal_bas_r: "1,371.50" }
    ]);

    expect(parsed?.rate).toBe(1371.5);
  });
});

describe("ExchangeRatesService", () => {
  it("stores an exact provider rate", async () => {
    const provider = new FakeProvider();
    provider.rates.set("2026-05-29", providerRate("2026-05-29", 1371.5));
    const service = serviceWith(provider);

    const rate = await service.getUsdKrwRateForDate(date("2026-05-29"));

    expect(rate.rate.toNumber()).toBe(1371.5);
    expect(rate.sourceDate).toEqual(date("2026-05-29"));
    expect(rate.fallbackType).toBe(ExchangeRateFallbackType.EXACT);
    expect(provider.rateCalls).toEqual(["2026-05-29"]);
  });

  it("deduplicates dates before provider lookup", async () => {
    const provider = new FakeProvider();
    provider.rates.set("2026-05-29", providerRate("2026-05-29", 1371.5));
    const service = serviceWith(provider);

    const rates = await service.ensureUsdKrwRatesForDates([date("2026-05-29"), date("2026-05-29")]);

    expect(rates.size).toBe(1);
    expect(provider.rateCalls).toEqual(["2026-05-29"]);
  });

  it("uses the latest stored rate on or before the requested date when provider returns no exact rate", async () => {
    const provider = new FakeProvider();
    provider.rates.set("2026-05-25", null);
    const prisma = new FakePrisma();
    prisma.exchangeRate.rows.push(exchangeRateRow("2026-05-24", "2026-05-24", 1300, ExchangeRateFallbackType.EXACT));
    const service = serviceWith(provider, prisma);

    const rate = await service.getUsdKrwRateForDate(date("2026-05-25"));

    expect(rate.rateDate).toEqual(date("2026-05-25"));
    expect(rate.sourceDate).toEqual(date("2026-05-24"));
    expect(rate.rate.toNumber()).toBe(1300);
    expect(rate.fallbackType).toBe(ExchangeRateFallbackType.PREVIOUS_AVAILABLE);
  });

  it("prefers provider lookback over an older stored previous rate", async () => {
    const provider = new FakeProvider();
    provider.rates.set("2026-05-25", null);
    provider.rates.set("2026-05-24", null);
    provider.rates.set("2026-05-23", providerRate("2026-05-23", 1295.25));
    const prisma = new FakePrisma();
    prisma.exchangeRate.rows.push(exchangeRateRow("2026-05-21", "2026-05-21", 1200, ExchangeRateFallbackType.EXACT));
    const service = serviceWith(provider, prisma);

    const rate = await service.getUsdKrwRateForDate(date("2026-05-25"));

    expect(provider.rateCalls).toEqual(["2026-05-25", "2026-05-24", "2026-05-23"]);
    expect(rate.sourceDate).toEqual(date("2026-05-23"));
    expect(rate.rate.toNumber()).toBe(1295.25);
    expect(rate.fallbackType).toBe(ExchangeRateFallbackType.PREVIOUS_AVAILABLE);
  });

  it("looks back through provider dates when no stored previous rate exists", async () => {
    const provider = new FakeProvider();
    provider.rates.set("2026-05-25", null);
    provider.rates.set("2026-05-24", null);
    provider.rates.set("2026-05-23", providerRate("2026-05-23", 1295.25));
    const service = serviceWith(provider);

    const rate = await service.getUsdKrwRateForDate(date("2026-05-25"));

    expect(provider.rateCalls).toEqual(["2026-05-25", "2026-05-24", "2026-05-23"]);
    expect(rate.rateDate).toEqual(date("2026-05-25"));
    expect(rate.sourceDate).toEqual(date("2026-05-23"));
    expect(rate.fallbackType).toBe(ExchangeRateFallbackType.PREVIOUS_AVAILABLE);
  });

  it("uses unrestricted latest stored rate when provider fails", async () => {
    const provider = new FakeProvider();
    provider.errors.add("2026-05-20");
    const prisma = new FakePrisma();
    prisma.exchangeRate.rows.push(exchangeRateRow("2026-05-29", "2026-05-29", 1370, ExchangeRateFallbackType.EXACT));
    const service = serviceWith(provider, prisma);

    const rate = await service.getUsdKrwRateForDate(date("2026-05-20"));

    expect(rate.rateDate).toEqual(date("2026-05-20"));
    expect(rate.sourceDate).toEqual(date("2026-05-29"));
    expect(rate.rate.toNumber()).toBe(1370);
    expect(rate.fallbackType).toBe(ExchangeRateFallbackType.LATEST_AVAILABLE);
  });

  it("uses provider latest when exact, stored, and lookback rates are unavailable", async () => {
    const provider = new FakeProvider();
    provider.latest = providerRate("2026-05-29", 1370);
    const service = serviceWith(provider);

    const rate = await service.getUsdKrwRateForDate(date("2026-05-20"));

    expect(provider.latestCalls).toBe(1);
    expect(rate.sourceDate).toEqual(date("2026-05-29"));
    expect(rate.fallbackType).toBe(ExchangeRateFallbackType.LATEST_AVAILABLE);
  });
});

function serviceWith(provider: FakeProvider, prisma = new FakePrisma()) {
  return new ExchangeRatesService(
    prisma as never,
    provider as never,
    { get: (key: string) => (key === "EXCHANGE_RATE_LOOKBACK_DAYS" ? "3" : undefined) } as never
  );
}

class FakeProvider {
  rates = new Map<string, ProviderRate | null>();
  errors = new Set<string>();
  rateCalls: string[] = [];
  latest: ProviderRate | null = null;
  latestCalls = 0;

  async fetchRate(dateValue: Date) {
    const key = formatDateOnly(dateValue);
    this.rateCalls.push(key);
    if (this.errors.has(key)) {
      throw new Error(`Provider failed for ${key}`);
    }
    return this.rates.get(key) ?? null;
  }

  async fetchLatestRate() {
    this.latestCalls += 1;
    return this.latest;
  }
}

class FakePrisma {
  exchangeRate = new FakeExchangeRateDelegate();
}

class FakeExchangeRateDelegate {
  rows: ExchangeRateRecord[] = [];

  async findUnique(input: { where: { rateDate_baseCurrency_quoteCurrency_provider: UniqueRateKey } }) {
    const key = input.where.rateDate_baseCurrency_quoteCurrency_provider;
    return this.rows.find((row) => matchesUnique(row, key)) ?? null;
  }

  async findFirst(input: { where: { sourceDate?: { lte: Date } } }) {
    const sourceDateLimit = input.where.sourceDate?.lte;
    return (
      [...this.rows]
        .filter((row) => (sourceDateLimit ? row.sourceDate <= sourceDateLimit : true))
        .sort((a, b) => b.sourceDate.getTime() - a.sourceDate.getTime() || b.rateDate.getTime() - a.rateDate.getTime())[0] ??
      null
    );
  }

  async upsert(input: { where: { rateDate_baseCurrency_quoteCurrency_provider: UniqueRateKey }; create: ExchangeRateRecord; update: Partial<ExchangeRateRecord> }) {
    const key = input.where.rateDate_baseCurrency_quoteCurrency_provider;
    const existing = this.rows.find((row) => matchesUnique(row, key));
    if (existing) {
      Object.assign(existing, input.update, { updatedAt: new Date() });
      return existing;
    }

    const created = {
      ...input.create,
      id: `rate-${this.rows.length + 1}`,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.rows.push(created);
    return created;
  }
}

type UniqueRateKey = {
  rateDate: Date;
  baseCurrency: string;
  quoteCurrency: string;
  provider: string;
};

type ExchangeRateRecord = {
  id: string;
  rateDate: Date;
  sourceDate: Date;
  baseCurrency: string;
  quoteCurrency: string;
  rate: Prisma.Decimal;
  provider: string;
  providerPayload: unknown;
  fallbackType: ExchangeRateFallbackType;
  fetchedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function providerRate(dateKey: string, rate: number): ProviderRate {
  return { date: date(dateKey), provider: KOREA_EXIM_PROVIDER, rate, rawPayload: { cur_unit: "USD" } };
}

function exchangeRateRow(rateDate: string, sourceDate: string, rate: number, fallbackType: ExchangeRateFallbackType): ExchangeRateRecord {
  return {
    id: `seed-${rateDate}`,
    rateDate: date(rateDate),
    sourceDate: date(sourceDate),
    baseCurrency: "USD",
    quoteCurrency: "KRW",
    rate: new Prisma.Decimal(rate),
    provider: KOREA_EXIM_PROVIDER,
    providerPayload: null,
    fallbackType,
    fetchedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

function matchesUnique(row: ExchangeRateRecord, key: UniqueRateKey) {
  return (
    row.rateDate.getTime() === key.rateDate.getTime() &&
    row.baseCurrency === key.baseCurrency &&
    row.quoteCurrency === key.quoteCurrency &&
    row.provider === key.provider
  );
}

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) {
    throw new Error(`Invalid test date: ${value}`);
  }
  return parsed;
}
