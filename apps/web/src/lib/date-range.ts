import { format, subDays } from "date-fns";

export type DateRange = {
  from: string;
  to: string;
};

export function defaultRange(days = 7): DateRange {
  const today = new Date();
  return {
    from: format(subDays(today, days - 1), "yyyy-MM-dd"),
    to: format(today, "yyyy-MM-dd")
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
