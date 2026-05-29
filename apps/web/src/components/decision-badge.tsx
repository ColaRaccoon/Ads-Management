export function DecisionBadge({ decision }: { decision?: string | null }) {
  if (!decision) {
    return <span className="badge">-</span>;
  }
  return <span className={`badge ${decision.toLowerCase()}`}>{decision}</span>;
}
