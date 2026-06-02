import { format, subDays } from "date-fns";

export type DateRange = {
  from: string;
  to: string;
};

export const rangePresets = [
  { label: "오늘", days: 1 },
  { label: "최근 3일", days: 3 },
  { label: "최근 7일", days: 7 },
  { label: "최근 14일", days: 14 }
] as const;

export function defaultRange(days = 7): DateRange {
  return presetRange(days);
}

export function presetRange(days: number): DateRange {
  const end = subDays(new Date(), 1);
  return {
    from: format(subDays(end, days - 1), "yyyy-MM-dd"),
    to: format(end, "yyyy-MM-dd")
  };
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
