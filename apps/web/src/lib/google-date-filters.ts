import { koreaYesterdayDateInput } from "./korea-date";

export type GoogleDateFilters = {
  from: string;
  to: string;
  connectionId: string;
  cafe24ConnectionId: string;
  productId: string;
};

export const emptyGoogleDateFilters: GoogleDateFilters = {
  from: "", to: "", connectionId: "", cafe24ConnectionId: "", productId: ""
};

export function googleYesterdayFilters(values: GoogleDateFilters, now = new Date()): GoogleDateFilters {
  const yesterday = koreaYesterdayDateInput(now);
  return { ...values, from: yesterday, to: yesterday };
}

export function readGoogleDateFilters(search: string, now = new Date()): GoogleDateFilters {
  const params = new URLSearchParams(search);
  const values: GoogleDateFilters = {
    from: params.get("from") ?? "", to: params.get("to") ?? "",
    connectionId: params.get("connectionId") ?? "",
    cafe24ConnectionId: params.get("cafe24ConnectionId") ?? "",
    productId: params.get("productId") ?? ""
  };
  // Explicit dates win over an old completion-mode marker; partial dates stay visible for correction.
  if (values.from || values.to) return values;
  // Legacy range=complete links now use yesterday; the UI never requests an undated report.
  return googleYesterdayFilters(values, now);
}

export function googleDateFilterError(values: GoogleDateFilters): string | null {
  if (!values.from || !values.to) return "달력에서 날짜를 선택해 주세요.";
  for (const value of [values.from, values.to]) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      return "올바른 시작일과 종료일을 선택하세요.";
    }
  }
  return values.from > values.to ? "종료일은 시작일보다 빠를 수 없습니다." : null;
}

export function googleFilterQuery(values: GoogleDateFilters) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => Boolean(value))).toString();
}
