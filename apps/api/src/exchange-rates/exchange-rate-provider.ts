import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { formatDateOnly, toDateOnly } from "../domain/date-number";

export const KOREA_EXIM_PROVIDER = "KOREA_EXIM";

export type ProviderRate = {
  date: Date;
  provider: string;
  rate: number;
  rawPayload?: unknown;
};

export interface ExchangeRateProvider {
  fetchRate(date: Date): Promise<ProviderRate | null>;
  fetchLatestRate(): Promise<ProviderRate | null>;
}

@Injectable()
export class KoreaEximExchangeRateProvider implements ExchangeRateProvider {
  private readonly endpoint = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON";

  constructor(private readonly config: ConfigService) {}

  async fetchRate(date: Date): Promise<ProviderRate | null> {
    const authKey = this.config.get<string>("KOREA_EXIM_API_KEY");
    if (!authKey) {
      throw new Error("KOREA_EXIM_API_KEY 환경변수가 설정되지 않았습니다.");
    }

    const searchDate = formatDateOnly(normalizeDateOnly(date)).replace(/-/g, "");
    const params = new URLSearchParams({ authkey: authKey, searchdate: searchDate, data: "AP01" });
    const response = await fetch(`${this.endpoint}?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`한국수출입은행 환율 API 요청 실패: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("한국수출입은행 환율 API 응답 형식이 올바르지 않습니다.");
    }

    const parsed = parseKoreaEximUsdKrwRate(payload);
    if (!parsed) {
      return null;
    }

    return {
      date: normalizeDateOnly(date),
      provider: KOREA_EXIM_PROVIDER,
      rate: parsed.rate,
      rawPayload: parsed.row
    };
  }

  async fetchLatestRate(): Promise<ProviderRate | null> {
    const lookbackDays = configNumber(this.config.get<string>("EXCHANGE_RATE_LOOKBACK_DAYS"), 10);
    const today = todayInSeoul();
    for (let daysAgo = 0; daysAgo <= lookbackDays; daysAgo += 1) {
      const rate = await this.fetchRate(addDays(today, -daysAgo));
      if (rate) {
        return rate;
      }
    }
    return null;
  }
}

export function parseKoreaEximUsdKrwRate(payload: unknown[]): { rate: number; row: Record<string, unknown> } | null {
  const row = payload.find((item) => isRecord(item) && item.cur_unit === "USD");
  if (!isRecord(row)) {
    return null;
  }

  const dealBasRate = row.deal_bas_r;
  if (dealBasRate === undefined || dealBasRate === null) {
    return null;
  }

  const parsed = Number(String(dealBasRate).replace(/,/g, "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return { rate: parsed, row };
}

function normalizeDateOnly(date: Date) {
  return toDateOnly(formatDateOnly(date)) ?? date;
}

function todayInSeoul() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return toDateOnly(formatter.format(new Date())) ?? normalizeDateOnly(new Date());
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000);
}

function configNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
