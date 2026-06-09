import { format, subDays } from "date-fns";

export type DateRange = {
  from: string;
  to: string;
};

export const rangePresets = [
  { label: "어제", days: 1 },
  { label: "최근 3일", days: 3 },
  { label: "최근 7일", days: 7 },
  { label: "최근 14일", days: 14 }
] as const;

export function defaultRange(days = 7): DateRange {
  return presetRange(days);
}

export function defaultRangeForPath(pathname?: string | null): DateRange {
  return defaultRange(pathname === "/ads" ? 1 : 7);
}

export function presetRange(days: number): DateRange {
  const end = subDays(new Date(), 1);
  return {
    from: format(subDays(end, days - 1), "yyyy-MM-dd"),
    to: format(end, "yyyy-MM-dd")
  };
}

export function readCachedRange(pathname?: string | null): DateRange | null {
  if (typeof window === "undefined" || !pathname) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(rangeStorageKey(pathname));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DateRange>;
    if (isIsoDate(parsed.from) && isIsoDate(parsed.to)) {
      return { from: parsed.from, to: parsed.to };
    }
  } catch {
    return null;
  }
  return null;
}

export function writeCachedRange(pathname: string | null | undefined, range: DateRange) {
  if (typeof window === "undefined" || !pathname) {
    return;
  }
  window.localStorage.setItem(rangeStorageKey(pathname), JSON.stringify(range));
}

function rangeStorageKey(pathname: string) {
  return `meta-ads-performance:range:${pathname}`;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
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
