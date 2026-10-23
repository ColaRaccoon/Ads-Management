import { SyncTrigger } from "@prisma/client";
import { syncError } from "./sync-contract";

type ProviderRunScope = {
  trigger: SyncTrigger;
  fromDate: Date;
  toDate: Date;
  units: { unitKey: string }[];
  connection: { timeZone: string };
};

function isoDay(date: Date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) syncError("RUN_LIMIT_EXCEEDED");
  return date.toISOString().slice(0, 10);
}

function shiftDay(day: string, offset: number) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function localToday(now: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric",
      month: "2-digit", day: "2-digit" }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const day = `${value("year")}-${value("month")}-${value("day")}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) syncError("TIMEZONE_MISMATCH");
    return day;
  } catch { syncError("TIMEZONE_MISMATCH"); }
}

/** Rejects legacy queued ranges before a provider lease or read can be acquired. */
export function assertGoogleMetaRunScope(run: ProviderRunScope, now = new Date()) {
  const lastCompletedDay = shiftDay(localToday(now, run.connection.timeZone), -1);
  const from = isoDay(run.fromDate);
  const to = isoDay(run.toDate);
  let expected: string[];
  if (run.trigger === SyncTrigger.SCHEDULED) {
    // Freshness is checked when a new run is queued. An already queued run
    // must remain resumable after the account's local calendar day changes.
    if (to > lastCompletedDay) syncError("RUN_LIMIT_EXCEEDED");
    expected = Array.from({ length: 7 }, (_, index) => shiftDay(from, index));
  } else if (run.trigger === SyncTrigger.MANUAL || run.trigger === SyncTrigger.BACKFILL) {
    if (from !== to || to > lastCompletedDay) syncError("RUN_LIMIT_EXCEEDED");
    expected = [from];
  } else {
    // RETRY has no original-run reference in the current schema. Re-entering the
    // same PARTIAL run keeps its original trigger and is checked above.
    syncError("RUN_LIMIT_EXCEEDED");
  }
  if (from !== expected[0] || to !== expected[expected.length - 1] ||
      run.units.length !== expected.length ||
      run.units.some((unit, index) => unit.unitKey !== expected[index]))
    syncError("RUN_LIMIT_EXCEEDED");
}
