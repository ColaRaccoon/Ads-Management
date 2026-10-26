/** Explicit purposes preserve the meaning and hashes of legacy schedules. */
export type ScheduleDefinition = { key: string; connectionId: string; anchorAt: string;
  windowMinutes: number; kind?: "META_DAILY" | "GOOGLE_DAILY" | "GOOGLE_RECHECK_D7" };

export function readScheduleDefinitions(env: NodeJS.ProcessEnv = process.env): ScheduleDefinition[] {
  const parsed: unknown = JSON.parse(env.DAILY_SYNC_SCHEDULES ?? "[]");
  if (!Array.isArray(parsed) || parsed.length > 30) throw Error("INVALID_SCHEDULE");
  const keys = new Set<string>(), purposes = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" ||
        !["anchorAt,connectionId,key,windowMinutes", "anchorAt,connectionId,key,kind,windowMinutes"].includes(Object.keys(item).sort().join()) ||
        item.kind !== undefined && !["META_DAILY", "GOOGLE_DAILY", "GOOGLE_RECHECK_D7"].includes(item.kind) ||
        !/^[a-z][a-z0-9-]{2,63}$/.test(item.key) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.connectionId) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.anchorAt) ||
        !Number.isFinite(Date.parse(item.anchorAt)) || new Date(item.anchorAt).toISOString() !== item.anchorAt ||
        !Number.isInteger(item.windowMinutes) || item.windowMinutes < 5 || item.windowMinutes > 120 ||
        keys.has(item.key) || purposes.has(`${item.connectionId}:${item.kind ?? "LEGACY"}`)) throw Error("INVALID_SCHEDULE");
    keys.add(item.key); purposes.add(`${item.connectionId}:${item.kind ?? "LEGACY"}`);
  }
  return parsed;
}

export function definitionCadenceDays(provider: string, definition: ScheduleDefinition): 1 | 7 {
  if (definition.kind === "META_DAILY") {
    if (provider !== "META") throw Error("INVALID_SCHEDULE_PROVIDER");
    return 1;
  }
  if (definition.kind === "GOOGLE_DAILY" || definition.kind === "GOOGLE_RECHECK_D7") {
    if (provider !== "GOOGLE") throw Error("INVALID_SCHEDULE_PROVIDER");
    return 1;
  }
  return provider === "CAFE24" ? 1 : 7;
}

type ScheduledRunIdentity = { provider?: string; connectionId?: string; requestKey?: string };

function runDefinition(input: ScheduledRunIdentity) {
  if (!input.connectionId || !input.requestKey) return undefined;
  const match = /^schedule:([a-z][a-z0-9-]{2,63}):[a-f0-9]{64}$/.exec(input.requestKey);
  return match ? readScheduleDefinitions().find(d => d.key === match[1] && d.connectionId === input.connectionId) : undefined;
}

export function definitionEndDayOffset(definition: ScheduleDefinition): 1 | 7 {
  return definition.kind === "GOOGLE_RECHECK_D7" ? 7 : 1;
}

export function scheduledRunDayCount(input: ScheduledRunIdentity): 1 | 7 {
  const definition = runDefinition(input);
  return definition ? definitionCadenceDays(input.provider ?? "", definition) : input.provider === "CAFE24" ? 1 : 7;
}

export function scheduledRunEndDayOffset(input: ScheduledRunIdentity): 1 | 7 {
  const definition = runDefinition(input);
  if (definition) definitionCadenceDays(input.provider ?? "", definition);
  return definition ? definitionEndDayOffset(definition) : 1;
}

export function scheduledRunPurpose(input: ScheduledRunIdentity): string {
  return `${scheduledRunDayCount(input)}:${scheduledRunEndDayOffset(input)}`;
}
