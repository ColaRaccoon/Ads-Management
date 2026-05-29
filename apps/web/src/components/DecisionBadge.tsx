const risk = new Set(["STOP_CANDIDATE", "LOSS", "ASC_TO_SC"]);
const good = new Set(["SCALE", "PROFIT", "SC_TO_CBO", "SC_TO_ASC", "CBO_TO_ASC"]);
const warn = new Set(["WATCH"]);

export function DecisionBadge({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="badge info">-</span>;
  }
  const className = risk.has(value) ? "risk" : good.has(value) ? "good" : warn.has(value) ? "warn" : "info";
  return <span className={`badge ${className}`}>{value}</span>;
}
