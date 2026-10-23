import { retryAfterMs } from "./bounded-request";

/** Cafe24 returns remaining window seconds separately from Retry-After. */
export function cafe24RetryAfterMs(headers: Headers) {
  const generic = retryAfterMs(headers.get("retry-after")) ?? 0;
  const seconds = ["x-cafe24-call-remain", "x-cafe24-time-remain"]
    .map((name) => headers.get(name))
    .map((value) => value && /^\d+(?:\.\d{1,3})?$/.test(value) ? Number(value) : null)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const cafe24 = Math.min(Math.ceil(Math.max(0, ...seconds) * 1_000), 10 * 60_000);
  return Math.max(generic, cafe24, 1_000);
}
