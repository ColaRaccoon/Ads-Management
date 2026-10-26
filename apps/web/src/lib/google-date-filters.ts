import { koreaYesterdayDateInput } from "./korea-date";

export type GoogleDateFilters = {
  from: string;
  to: string;
  connectionId: string;
  cafe24ConnectionId: string;
  productId: string;
  range: "" | "complete";
};

export const emptyGoogleDateFilters: GoogleDateFilters = {
  from: "", to: "", connectionId: "", cafe24ConnectionId: "", productId: "", range: ""
};

export function readGoogleDateFilters(search: string, now = new Date()): GoogleDateFilters {
  const params = new URLSearchParams(search);
  const values: GoogleDateFilters = {
    from: params.get("from") ?? "", to: params.get("to") ?? "",
    connectionId: params.get("connectionId") ?? "",
    cafe24ConnectionId: params.get("cafe24ConnectionId") ?? "",
    productId: params.get("productId") ?? "", range: ""
  };
  // Explicit dates win over an old completion-mode marker; partial dates stay visible for correction.
  if (values.from || values.to) return values;
  if (params.get("range") === "complete") return { ...values, range: "complete" };
  const yesterday = koreaYesterdayDateInput(now);
  return { ...values, from: yesterday, to: yesterday };
}

export function googleDateFilterError(values: GoogleDateFilters): string | null {
  if (values.range === "complete" && !values.from && !values.to) return null;
  if (!values.from || !values.to) return "시작일과 종료일을 모두 선택하세요. 수집 완료 기간은 별도 버튼으로 선택할 수 있습니다.";
  for (const value of [values.from, values.to]) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      return "올바른 시작일과 종료일을 선택하세요.";
    }
  }
  return values.from > values.to ? "종료일은 시작일보다 빠를 수 없습니다." : null;
}

export function googleFilterQuery(values: GoogleDateFilters, target: "url" | "api" = "url") {
  return new URLSearchParams(Object.entries(values).filter(([key, value]) => Boolean(value) && (key !== "range" || target === "url"))).toString();
}
