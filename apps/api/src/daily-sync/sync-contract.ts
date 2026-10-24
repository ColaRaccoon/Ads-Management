import { BadRequestException, ConflictException, HttpException, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { SourceDataKind, SourceProvider, SyncRunStatus, SyncTrigger } from "@prisma/client";

export const MAX_RUN_DAYS = 31;
export const MAX_RUN_MS = 10 * 60_000;
export const LEASE_MS = 2 * 60_000;
export const REQUEST_DEADLINE_MS = 20_000;
export const MAX_PROVIDER_ATTEMPTS = 3;
export const PAGE_ROW_LIMITS: Record<SourceDataKind, number> = {
  GOOGLE_CAMPAIGN: 10_000,
  META_AD: 50_000,
  META_ADSET: 50_000,
  CAFE24_ORDER: 10_000
};

export const SAFE_SYNC_CODES = new Set([
  "SOURCE_SELECTION_REQUIRED", "ACCOUNT_SCOPE_MISMATCH", "CURRENCY_MISMATCH",
  "TIMEZONE_MISMATCH", "FIELD_UNSUPPORTED", "ATTRIBUTION_MISMATCH",
  "PARTIAL_PAGE", "RECONCILIATION_FAILED", "LEASE_LOST", "RUN_LIMIT_EXCEEDED",
  "PROVIDER_AUTH_REQUIRED", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE",
  "PROVIDER_VERSION_UNVERIFIED"
]);

export function safeSyncCode(value: unknown): string {
  return typeof value === "string" && SAFE_SYNC_CODES.has(value) ? value : "PROVIDER_UNAVAILABLE";
}

export function syncError(code: string, status: 400 | 409 | 429 | 503 = 409): never {
  const body = { code: safeSyncCode(code), message: "The sync request cannot be completed.", details: null };
  if (status === 400) throw new BadRequestException(body);
  if (status === 503) throw new ServiceUnavailableException(body);
  if (status === 429) throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
  throw new ConflictException(body);
}

export function parseIsoDate(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) syncError("RUN_LIMIT_EXCEEDED", 400);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) syncError("RUN_LIMIT_EXCEEDED", 400);
    return date;
}

export function parseDateRange(fromDate: string, toDate: string, now = new Date(), timeZone = "UTC") {
  const from = parseIsoDate(fromDate);
  const to = parseIsoDate(toDate);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  if (days < 1 || days > MAX_RUN_DAYS || toDate > today) syncError("RUN_LIMIT_EXCEEDED", 400);
  return { from, to, days };
}

type RunScope = {
  provider: SourceProvider; timeZone: string; fromDate: string; toDate: string;
  trigger: SyncTrigger; actorUserId: string | null;
};

function accountToday(timeZone: string, now: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone,
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Existing run retries keep their original complete-day window after the calendar advances. */
export function assertSyncRunShape(input: RunScope, now = new Date()) {
  const from = parseIsoDate(input.fromDate), to = parseIsoDate(input.toDate);
  const days = (to.getTime() - from.getTime()) / 86_400_000 + 1;
  if (input.toDate >= accountToday(input.timeZone, now)) syncError("RUN_LIMIT_EXCEEDED", 400);
  if (input.trigger === SyncTrigger.SCHEDULED) {
    if (input.actorUserId !== null) syncError("RUN_LIMIT_EXCEEDED", 400);
    if (days !== (input.provider === SourceProvider.CAFE24 ? 1 : 7))
      syncError("RUN_LIMIT_EXCEEDED", 400);
  } else if ((input.trigger !== SyncTrigger.MANUAL && input.trigger !== SyncTrigger.BACKFILL) ||
      days !== 1) syncError("RUN_LIMIT_EXCEEDED", 400);
}

/** New scheduled windows end on the most recently completed account-local day. */
export function assertSyncRunScope(input: RunScope, now = new Date()) {
  assertSyncRunShape(input, now);
  if (input.trigger === SyncTrigger.SCHEDULED) {
    const today = accountToday(input.timeZone, now);
    const yesterday = parseIsoDate(today).getTime() - 86_400_000;
    const toDate = new Date(yesterday).toISOString().slice(0, 10);
    const days = input.provider === SourceProvider.CAFE24 ? 1 : 7;
    const fromDate = new Date(yesterday - (days - 1) * 86_400_000)
      .toISOString().slice(0, 10);
    if (input.fromDate !== fromDate || input.toDate !== toDate)
      syncError("RUN_LIMIT_EXCEEDED", 400);
  }
}

/** One replacement is allowed for a failed scheduled window; action-required needs an operator. */
export function assertScheduledWindowCadence(input: { fromDate: string; toDate: string },
  overlapping: Array<{ fromDate: Date; toDate: Date; status: SyncRunStatus }>) {
  if (overlapping.length > 1) syncError("RUN_LIMIT_EXCEEDED");
  let retry = false;
  for (const run of overlapping) {
    if (run.fromDate.toISOString().slice(0, 10) !== input.fromDate ||
        run.toDate.toISOString().slice(0, 10) !== input.toDate ||
        run.status !== SyncRunStatus.FAILED)
      syncError("RUN_LIMIT_EXCEEDED");
    retry = true;
  }
  return retry;
}

export function validateAccountKey(provider: SourceProvider, externalAccountId: string, shopKey: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(externalAccountId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(shopKey)) syncError("ACCOUNT_SCOPE_MISMATCH", 400);
  if (provider !== SourceProvider.CAFE24 && shopKey !== "default") syncError("ACCOUNT_SCOPE_MISMATCH", 400);
  if (provider === SourceProvider.GOOGLE && !/^\d+$/.test(externalAccountId)) syncError("ACCOUNT_SCOPE_MISMATCH", 400);
}

export function assertBoundedRows(kind: SourceDataKind, count: number, pageCount: number, complete: boolean) {
  if (!Number.isSafeInteger(count) || count < 0 || count > PAGE_ROW_LIMITS[kind] ||
      !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 1_000) {
    syncError("RUN_LIMIT_EXCEEDED");
  }
  if (!complete) syncError("PARTIAL_PAGE");
}

export function enabledSync(env: NodeJS.ProcessEnv = process.env) {
  return env.DAILY_SYNC_FEATURE_ENABLED === "true";
}

export function assertEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (!enabledSync(env)) syncError("PROVIDER_UNAVAILABLE", 503);
}

/** Prepare disabled connections without opening collection or source selection. */
export function assertSourceAdministrationEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (!enabledSync(env) && env.DAILY_SYNC_SOURCE_ADMIN_ENABLED !== "true")
    syncError("PROVIDER_UNAVAILABLE", 503);
}

/** One-account Cafe24 OAuth and read-only preflight without enabling canonical writes. */
export function assertCafe24TestReadEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (!enabledSync(env) && env.DAILY_SYNC_CAFE24_TEST_ENABLED !== "true")
    syncError("PROVIDER_UNAVAILABLE", 503);
}

/** Normal OAuth may precede enabling provider reads or collection. */
export function assertCafe24AuthorizationEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.DAILY_SYNC_SOURCE_ADMIN_ENABLED === "true") return;
  assertCafe24TestReadEnabled(env);
}

/** Headerless Order GET follows the app setting, which read_order cannot inspect. */
export function assertCafe24AppVersionEvidence(env: NodeJS.ProcessEnv = process.env,
  now = new Date()) {
  const version = env.DAILY_SYNC_CAFE24_APP_API_VERSION;
  const verifiedAt = env.DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const oldest = new Date(`${today}T00:00:00.000Z`);
  oldest.setUTCDate(oldest.getUTCDate() - 30);
  if (version !== "2026-09-01" || !verifiedAt || !/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt) ||
      Number.isNaN(Date.parse(`${verifiedAt}T00:00:00.000Z`)) ||
      new Date(`${verifiedAt}T00:00:00.000Z`).toISOString().slice(0, 10) !== verifiedAt ||
      verifiedAt > today || verifiedAt < oldest.toISOString().slice(0, 10))
    syncError("PROVIDER_VERSION_UNVERIFIED");
}

/** Seller-defined dropdown evidence is time-bound; never infer it from a value's shape. */
export function assertCafe24SellerOptionsEvidence(env: NodeJS.ProcessEnv = process.env,
  now = new Date()) {
  const verifiedAt = env.DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const oldest = new Date(`${today}T00:00:00.000Z`);
  oldest.setUTCDate(oldest.getUTCDate() - 30);
  if (env.DAILY_SYNC_CAFE24_SELLER_DROPDOWN !== "true" || !verifiedAt ||
      !/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt) ||
      Number.isNaN(Date.parse(`${verifiedAt}T00:00:00.000Z`)) ||
      new Date(`${verifiedAt}T00:00:00.000Z`).toISOString().slice(0, 10) !== verifiedAt ||
      verifiedAt > today || verifiedAt < oldest.toISOString().slice(0, 10))
    syncError("FIELD_UNSUPPORTED");
}

/** The seller-controlled option projection is checked on every complete day.
 * A CSV export for each new date is not required by the daily API contract. */
export function assertCafe24OptionProjectionDayEvidence(day: string,
  env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  if (day >= accountToday("Asia/Seoul", now)) syncError("FIELD_UNSUPPORTED");
  assertCafe24SellerOptionsEvidence(env, now);
}

/** Known C/R and explicitly approved E00 lines use the reviewed v1 all-items inclusion projection.
 * The client/writer also require the explicit status set, full snapshot and mapping. */
export function assertCafe24RawAllItemsV1Evidence(day: string,
  env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  if (day >= accountToday("Asia/Seoul", now)) syncError("FIELD_UNSUPPORTED");
  if (env.DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED !== "true" ||
      !recentCafe24EvidenceDate(env.DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT, now))
    syncError("FIELD_UNSUPPORTED");
}

/** The exact item-status set is configuration evidence for the v1 line projection. */
export function isCafe24V1ItemStatusCode(value: string) {
  return /^(?:[NCR][0-9]{2}|E00)$/.test(value);
}

export function requiresCafe24RawAllItemsEvidence(value: string | null | undefined) {
  return value === "E00" || /^[CR][0-9]{2}$/.test(value ?? "");
}

export function verifiedCafe24V1Statuses(env: NodeJS.ProcessEnv = process.env) {
  let parsed: unknown;
  try { parsed = JSON.parse(env.DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES ??
    env.DAILY_SYNC_CAFE24_VERIFIED_NORMAL_STATUSES ?? "[]"); }
  catch { syncError("FIELD_UNSUPPORTED"); }
  if (!Array.isArray(parsed) || parsed.length > 32 ||
      !parsed.every((value) => typeof value === "string" &&
        isCafe24V1ItemStatusCode(value)))
    syncError("FIELD_UNSUPPORTED");
  return new Set<string>(parsed);
}

/** An array of Cafe24 codes becomes a legacy CSV label only after a bounded,
 * explicit code-to-label comparison. Unknown codes remain null in the adapter. */
export function cafe24PaymentMethodCsvMap(env: NodeJS.ProcessEnv = process.env,
  now = new Date()): Readonly<Record<string, string>> | null {
  const raw = env.DAILY_SYNC_CAFE24_PAYMENT_METHOD_CSV_MAP;
  const verifiedAt = env.DAILY_SYNC_CAFE24_PAYMENT_METHOD_MAP_VERIFIED_AT;
  if (!raw && !verifiedAt) return null;
  if (!raw || !recentCafe24EvidenceDate(verifiedAt, now)) syncError("FIELD_UNSUPPORTED");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { syncError("FIELD_UNSUPPORTED"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).length < 1 || Object.keys(parsed).length > 32)
    syncError("FIELD_UNSUPPORTED");
  const result: Record<string, string> = Object.create(null);
  for (const [code, label] of Object.entries(parsed)) {
    if (!code || code.length > 64 || /[\u0000-\u001f\u007f]/.test(code) ||
        typeof label !== "string" || !label.trim() || label !== label.trim() ||
        label.length > 64 || /[,\u0000-\u001f\u007f]/.test(label))
      syncError("FIELD_UNSUPPORTED");
    result[code] = label;
  }
  for (const [code, label] of Object.entries(result)) {
    if ((code === "coupon") !== (label.normalize("NFKC") === "쿠폰"))
      syncError("FIELD_UNSUPPORTED");
  }
  return result;
}

function recentCafe24EvidenceDate(value: string | undefined, now: Date) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const oldest = new Date(`${today}T00:00:00.000Z`);
  oldest.setUTCDate(oldest.getUTCDate() - 30);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value &&
    value <= today && value >= oldest.toISOString().slice(0, 10);
}
