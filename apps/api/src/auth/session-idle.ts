export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

export function sessionIsIdle(lastSeenAt: Date | null, now = Date.now()) {
  return lastSeenAt === null || now - lastSeenAt.getTime() >= SESSION_IDLE_MS;
}

// The client reports how recently input occurred, never a server deadline.
export function activityAge(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,5}$/.test(value)) return undefined;
  const age = Number(value);
  return age <= 60_000 ? age : undefined;
}
