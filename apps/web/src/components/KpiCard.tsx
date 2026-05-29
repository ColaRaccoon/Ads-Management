import { formatKrw, formatNumber, formatUsd } from "@/lib/format";

type KpiCardProps = {
  label: string;
  value: unknown;
  kind?: "krw" | "usd" | "number";
  sub?: string;
};

export function KpiCard({ label, value, kind = "number", sub }: KpiCardProps) {
  const formatted = kind === "krw" ? formatKrw(value) : kind === "usd" ? formatUsd(value) : formatNumber(value);
  return (
    <div className="panel kpi">
      <div className="label">{label}</div>
      <div className="value">{formatted}</div>
      <div className="muted">{sub ?? "\u00A0"}</div>
    </div>
  );
}
