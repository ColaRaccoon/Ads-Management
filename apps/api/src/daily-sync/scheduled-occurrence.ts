import { createHash } from "node:crypto";
import { SourceProvider } from "@prisma/client";
import { parseIsoDate, syncError } from "./sync-contract";

// Cafe24 publish has a 30s transaction bound; leave 5s for the HTTP envelope.
export const SCHEDULE_UNIT_MS = 55_000;
export const SCHEDULE_MAX_UNIT_ATTEMPTS = 3;
export type ScheduleDefinition = { key: string; connectionId: string; anchorAt: string; windowMinutes: number };
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
// One explicitly approved isolated test occurrence; not a general scheduling override.
const APPROVED_TEST_OCCURRENCES = [
  ["phase08-cafe24", "0c35defe-45fc-4a54-bc79-704df7bca5b1", "CAFE24", "2026-10-15T01:00:00.000Z", 110],
  ["phase08-google", "b9ebee4b-5d4e-4eae-92b9-9facfbf3c900", "GOOGLE", "2026-10-15T01:01:00.000Z", 90],
  ["phase08-meta", "1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6", "META", "2026-10-15T01:02:00.000Z", 90],
  // Explicit new real-clock tests. Existing manual/scheduled runs are never inherited.
  ["phase08-meta", "1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6", "META", "2026-10-15T06:00:00.000Z", 35],
  ["phase08-cafe24", "0c35defe-45fc-4a54-bc79-704df7bca5b1", "CAFE24", "2026-10-15T06:40:00.000Z", 110],
  ["phase08-meta", "1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6", "META", "2026-10-15T07:00:00.000Z", 90],
  ["phase08-cafe24", "0c35defe-45fc-4a54-bc79-704df7bca5b1", "CAFE24", "2026-10-16T01:15:00.000Z", 110],
  ["phase08-meta", "1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6", "META", "2026-10-16T01:20:00.000Z", 90],
  // Separate approved repeat test: all seven empty units fetch again, no inheritance.
  ["phase08-meta", "1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6", "META", "2026-10-16T03:30:00.000Z", 90]
];
function approvedIsolatedTestOccurrence(definition: ScheduleDefinition, provider: SourceProvider, scheduledFor: string, timeZone: string) {
  return timeZone === "Asia/Seoul" &&
    process.env.SUPABASE_URL === "https://ehnfrrmbkvlsbpvqcvkr.supabase.co" &&
    process.env.SUPABASE_DATABASE_PROJECT_REF === "ehnfrrmbkvlsbpvqcvkr" &&
    process.env.SUPABASE_DATABASE_SCHEMA === "phase08_meta_ads" &&
    process.env.SUPABASE_DATABASE_RUNTIME_USER === "phase08_runtime" &&
    process.env.DEPLOYMENT_ENVIRONMENT_ID === "phase08-daily-data-sync-08" &&
    process.env.RUNTIME_API_TARGET_ID === "phase08-full-app" &&
    APPROVED_TEST_OCCURRENCES.some(([key, id, expectedProvider, anchor, window]) =>
      definition.key === key && definition.connectionId === id && provider === expectedProvider &&
      definition.anchorAt === anchor && scheduledFor === anchor && definition.windowMinutes === window);
}
export function instant(value: string) {
  const date = new Date(value);
  if (!INSTANT.test(value) || !Number.isFinite(date.getTime()) || date.toISOString() !== value)
    syncError("RUN_LIMIT_EXCEEDED", 400);
  return date;
}
export function schedules(env: NodeJS.ProcessEnv = process.env): ScheduleDefinition[] {
  try {
    const parsed: unknown = JSON.parse(env.DAILY_SYNC_SCHEDULES ?? "[]");
    if (!Array.isArray(parsed) || parsed.length > 30) throw new Error();
    const keys = new Set<string>(), connections = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Object.keys(item).sort().join() !== "anchorAt,connectionId,key,windowMinutes" ||
          !/^[a-z][a-z0-9-]{2,63}$/.test(item.key) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.connectionId) ||
          !Number.isInteger(item.windowMinutes) || item.windowMinutes < 5 || item.windowMinutes > 120 ||
          keys.has(item.key) || connections.has(item.connectionId)) throw new Error();
      instant(item.anchorAt);
      keys.add(item.key); connections.add(item.connectionId);
    }
    return parsed;
  } catch { return syncError("ACCOUNT_SCOPE_MISMATCH"); }
}
export function occurrence(definition: ScheduleDefinition, provider: SourceProvider, timeZone: string,
  scheduledFor: string, now = new Date()) {
  const scheduled = instant(scheduledFor), anchor = instant(definition.anchorAt);
  const interval = (provider === SourceProvider.CAFE24 ? 1 : 7) * 86_400_000;
  if (scheduled < anchor || (scheduled.getTime() - anchor.getTime()) % interval !== 0 || scheduled > now)
    syncError("RUN_LIMIT_EXCEEDED", 400);
  const kst = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(scheduled);
  // Reserve the existing 04:00 Storage task. Weekly times remain provisional until step 10.
  const minutes = Number(kst.slice(0, 2)) * 60 + Number(kst.slice(3));
  if (!approvedIsolatedTestOccurrence(definition, provider, scheduledFor, timeZone) &&
      (provider === SourceProvider.CAFE24 && (kst !== "02:00" || scheduled.getUTCSeconds() !== 0 || scheduled.getUTCMilliseconds() !== 0) ||
      minutes + definition.windowMinutes > 240 || minutes < 120))
    syncError("RUN_LIMIT_EXCEEDED", 400);
  const localDay = new Intl.DateTimeFormat("en-CA", { timeZone,
    year: "numeric", month: "2-digit", day: "2-digit" }).format(scheduled);
  const end = parseIsoDate(localDay).getTime() - 86_400_000;
  const days = provider === SourceProvider.CAFE24 ? 1 : 7;
  return { definition, scheduledFor, fromDate: new Date(end - (days - 1) * 86_400_000).toISOString().slice(0, 10),
    toDate: new Date(end).toISOString().slice(0, 10),
    deadlineAt: new Date(scheduled.getTime() + definition.windowMinutes * 60_000),
    requestKey: `schedule:${definition.key}:${createHash("sha256").update(scheduledFor).digest("hex")}` };
}
