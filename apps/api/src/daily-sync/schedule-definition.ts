/** Purpose is explicit only for the new Meta daily schedule. Legacy keys and
 * request hashes retain their original weekly meaning and history. */
export type ScheduleDefinition = { key: string; connectionId: string; anchorAt: string;
  windowMinutes: number; kind?: "META_DAILY" };

export function readScheduleDefinitions(env: NodeJS.ProcessEnv = process.env): ScheduleDefinition[] {
  const parsed: unknown = JSON.parse(env.DAILY_SYNC_SCHEDULES ?? "[]");
  if (!Array.isArray(parsed) || parsed.length > 30) throw Error("INVALID_SCHEDULE");
  const keys = new Set<string>(), purposes = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" ||
        !["anchorAt,connectionId,key,windowMinutes", "anchorAt,connectionId,key,kind,windowMinutes"].includes(Object.keys(item).sort().join()) ||
        item.kind !== undefined && item.kind !== "META_DAILY" ||
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
  return provider === "CAFE24" ? 1 : 7;
}

export function scheduledRunDayCount(input: { provider?: string; connectionId?: string; requestKey?: string }): 1 | 7 {
  if (input.provider === "CAFE24") return 1;
  if (input.provider !== "META" || !input.connectionId || !input.requestKey) return 7;
  const match = /^schedule:([a-z][a-z0-9-]{2,63}):[a-f0-9]{64}$/.exec(input.requestKey);
  return match && readScheduleDefinitions().some(d => d.key === match[1] &&
    d.connectionId === input.connectionId && d.kind === "META_DAILY") ? 1 : 7;
}
