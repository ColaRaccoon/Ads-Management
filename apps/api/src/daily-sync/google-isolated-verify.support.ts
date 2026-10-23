import { randomUUID } from "node:crypto";
import { SourceCoverageState, SourceKind } from "@prisma/client";

const DAY_MS = 86_400_000;

/** Each manual verification must make a fresh read, even for the same date range. */
export function verificationRequestKey(fromDate: string, toDate: string) {
  return `google-05-${fromDate}-${toDate}-${randomUUID()}`;
}

/** Require one successful coverage record from this run for every requested date. */
export function completeVerificationCoverage(run: { id: string; fromDate: Date; toDate: Date },
  rows: Array<{ metricDate: Date; source: SourceKind; state: SourceCoverageState;
    lastSuccessRunId: string | null }>) {
  const from = run.fromDate.getTime();
  const to = run.toDate.getTime();
  const dayCount = Math.floor((to - from) / DAY_MS) + 1;
  if (!Number.isSafeInteger(dayCount) || dayCount < 1 || dayCount > 31 || rows.length !== dayCount)
    return false;
  return rows.every((row, index) =>
    row.metricDate.getTime() === from + index * DAY_MS &&
    row.source === SourceKind.API && row.lastSuccessRunId === run.id &&
    (row.state === SourceCoverageState.COMPLETE_ZERO ||
      row.state === SourceCoverageState.COMPLETE_NONZERO));
}
