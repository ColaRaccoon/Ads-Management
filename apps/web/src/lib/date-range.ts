import { koreaTodayDateInput, koreaYesterdayDateInput } from "./korea-date";

export type DateRange = {
  from: string;
  to: string;
};

export const rangePresets = [
  { label: "오늘", days: 0 },
  { label: "어제", days: 1 },
  { label: "최근 3일", days: 3 },
  { label: "최근 7일", days: 7 },
  { label: "최근 14일", days: 14 }
] as const;

export function defaultRange(days = 1): DateRange {
  return presetRange(days);
}

export function defaultRangeForPath(_pathname?: string | null): DateRange {
  return defaultRange();
}

export function presetRange(days: number): DateRange {
  if (days === 0) {
    const today = koreaTodayDateInput();
    return { from: today, to: today };
  }
  const end = koreaYesterdayDateInput();
  return {
    from: shiftDateInput(end, 1 - days),
    to: end
  };
}

function shiftDateInput(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function money(value: number | null | undefined, currency = "KRW") {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  if (currency === "USD") {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

export function numberFmt(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return value.toLocaleString("ko-KR", { maximumFractionDigits: digits });
}
