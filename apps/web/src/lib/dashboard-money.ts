import { storefrontDecimal } from "./storefront-display";

export function dashboardMoney(value: string | null | undefined, currency = "KRW") {
  if (value == null) return "-";
  const formatted = storefrontDecimal(value);
  return formatted === "—" ? "-" : currency === "USD" ? `$${formatted}` : `${formatted}원`;
}

/** Exact decimal addition for the stage rollup; chart coordinates are projected separately. */
export function addDashboardMoney(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return null;
  const parts = [left, right].map(value => {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid dashboard decimal");
    const [integer, fraction = ""] = value.split(".");
    return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
  });
  const scale = Math.max(...parts.map(p => p.scale));
  const total = parts.reduce((sum, p) => sum + p.coefficient * 10n ** BigInt(scale - p.scale), 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "") : digits;
  return `${total < 0n ? "-" : ""}${text}`;
}

export function collapseStageRows(rows: Array<Record<string, any>>) {
  const map = new Map<string, { group: string; spendKrw: string | null; purchaseCount: number | null; hasApiMetrics: boolean; attributionContexts: string[] }>();
  for (const row of rows) {
    const group = String(row.group ?? "UNKNOWN");
    const current = map.get(group) ?? { group, spendKrw: "0", purchaseCount: 0, hasApiMetrics: false, attributionContexts: [] };
    current.spendKrw = addDashboardMoney(current.spendKrw, row.spendKrw ?? null);
    current.purchaseCount = current.purchaseCount === null || row.purchaseCount == null ? null : current.purchaseCount + row.purchaseCount;
    current.hasApiMetrics ||= row.hasApiMetrics === true;
    current.attributionContexts = [...new Set([...current.attributionContexts, ...(row.attributionContexts ?? [])])];
    if (current.hasApiMetrics && current.attributionContexts.length > 1) current.purchaseCount = null;
    map.set(group, current);
  }
  return Array.from(map.values());
}

const moneyKeys = ["spendKrw", "cpaKrw", "marginKrw"];
/** Number is used only for Recharts geometry. Original strings remain available to tooltips. */
export function dashboardChartRows(rows: unknown[]) {
  return rows.map(value => {
    const row = value as Record<string, unknown>;
    const original: Record<string, string | null> = {};
    const projected = { ...row };
    for (const key of moneyKeys) {
      if (!(key in row)) continue;
      const text = row[key] == null ? null : String(row[key]);
      original[key] = text;
      const number = text === null ? NaN : Number(text);
      projected[key] = Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : null;
    }
    return { ...projected, dashboardMoneyOriginal: original };
  });
}

export function dashboardChartTooltip(value: unknown, _name: unknown, item?: { dataKey?: unknown; payload?: { dashboardMoneyOriginal?: Record<string, string | null> } }) {
  const key = String(item?.dataKey ?? "");
  const original = item?.payload?.dashboardMoneyOriginal;
  if (original && key in original) return original[key] === null ? "-" : storefrontDecimal(original[key]);
  return value == null ? "-" : Number.isFinite(Number(value)) ? Math.floor(Number(value)).toLocaleString("ko-KR") : String(value);
}
