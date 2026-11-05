import { createHash } from "node:crypto";
import { META_REPORTING_FIELDS } from "../domain/meta-reporting-measurements";

// Closed, bounded diagnostics only. No provider rows, names, IDs or exception text.
export const META_CHECKS = ["PROFILE_UNSUPPORTED", "MONEY_INVALID", "COUNT_INVALID",
  "REPORTING_ACTIVITY", "PURCHASE_PAIR_NULL_MISMATCH", "ZERO_PURCHASE_NONZERO_VALUE",
  "REMOVED_CHILD_NONZERO", "ACCOUNT_METRIC_NULL", "HIERARCHY_SPEND_TOTAL",
  "HIERARCHY_METRIC_TOTAL", "PROJECTION_MEMBERSHIP", "RETAINED_PARENT_NULL_METRIC"] as const;
const LEVELS = ["ad", "adset", "campaign", "ad_account"] as const;
const METRICS = ["amount_spent", "impressions", "clicks", "reach", "frequency", "link_click",
  "omni_purchase", "omni_purchase_values", "offsite_conversion_fb_pixel_purchase",
  "offsite_conversion_fb_pixel_purchase_values", ...Object.values(META_REPORTING_FIELDS)];
export type MetaCheckEvidence = {
  condition: typeof META_CHECKS[number]; level?: typeof LEVELS[number]; metric?: string;
  relation?: "CHILDREN" | "DESCENDANTS"; entityFingerprint?: string;
  expected?: string | null; observed?: string | null; delta?: string | null;
};
type CaptureEvidence = { fingerprint: string; observedAtUtc: string; totalPages: number;
  paginationComplete: boolean; requestedPageSize: number;
  rowCounts: Record<typeof LEVELS[number], number>;
  pagination?: Record<typeof LEVELS[number], { pages: number; received: number; reportedTotal: number | null; ended: boolean }> };
export type MetaFailureEvidence = { version: 1; check?: MetaCheckEvidence; capture?: CaptureEvidence };
const evidence = new WeakMap<object, MetaFailureEvidence>();
const pagination = new WeakMap<object, NonNullable<CaptureEvidence["pagination"]>>();
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const number = (value: unknown) => value === null || typeof value === "string" && /^-?\d{1,24}(?:\.\d{1,8})?$/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
/** Reject, rather than serialize, an unexpected field/value supplied by a caller. */
export function safeMetaFailureEvidence(value: unknown): MetaFailureEvidence | null {
  if (!object(value) || !keys(value, ["version", "check", "capture"]) || value.version !== 1) return null;
  if (value.check !== undefined) {
    const c = value.check;
    if (!object(c) || !keys(c, ["condition", "level", "metric", "relation", "entityFingerprint", "expected", "observed", "delta"]) ||
        !(META_CHECKS as readonly unknown[]).includes(c.condition) ||
        c.level !== undefined && !(LEVELS as readonly unknown[]).includes(c.level) ||
        c.metric !== undefined && !(METRICS as readonly unknown[]).includes(c.metric) ||
        c.relation !== undefined && !["CHILDREN", "DESCENDANTS"].includes(c.relation as string) ||
        c.entityFingerprint !== undefined && !hash(c.entityFingerprint) ||
        ["expected", "observed", "delta"].some(key => c[key] !== undefined && !number(c[key]))) return null;
  }
  if (value.capture !== undefined) {
    const c = value.capture;
    if (!object(c) || !keys(c, ["fingerprint", "observedAtUtc", "totalPages", "paginationComplete", "requestedPageSize", "rowCounts", "pagination"]) ||
        !hash(c.fingerprint) || typeof c.observedAtUtc !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.observedAtUtc) || !Number.isFinite(Date.parse(c.observedAtUtc)) ||
        !Number.isInteger(c.totalPages) || (c.totalPages as number) < 4 || (c.totalPages as number) > 100 ||
        typeof c.paginationComplete !== "boolean" || c.requestedPageSize !== 1000 ||
        !object(c.rowCounts) || Object.keys(c.rowCounts).sort().join() !== [...LEVELS].sort().join() ||
        Object.values(c.rowCounts).some(n => !Number.isInteger(n) || (n as number) < 0 || (n as number) > 50000)) return null;
    if (c.pagination !== undefined && (!object(c.pagination) || Object.keys(c.pagination).sort().join() !== [...LEVELS].sort().join() ||
        Object.values(c.pagination).some(p => !object(p) || !keys(p, ["pages", "received", "reportedTotal", "ended"]) ||
          !Number.isInteger(p.pages) || (p.pages as number) < 1 || (p.pages as number) > 100 ||
          !Number.isInteger(p.received) || (p.received as number) < 0 || (p.received as number) > 50000 ||
          p.reportedTotal !== null && (!Number.isInteger(p.reportedTotal) || (p.reportedTotal as number) < 0 || (p.reportedTotal as number) > 50000) ||
          typeof p.ended !== "boolean"))) return null;
  }
  if (value.check === undefined && value.capture === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as MetaFailureEvidence;
}
export function metaEntityFingerprint(level: string, id: unknown) {
  return createHash("sha256").update(JSON.stringify([level, id])).digest("hex");
}
export function attachMetaCheck(error: object, check: MetaCheckEvidence) {
  const safe = safeMetaFailureEvidence({ version: 1, check });
  if (safe) evidence.set(error, { ...evidence.get(error), ...safe });
}
export function attachMetaCapture(error: object, capture: CaptureEvidence) {
  const safe = safeMetaFailureEvidence({ version: 1, capture });
  if (safe) evidence.set(error, { ...evidence.get(error), ...safe });
}
export function recordMetaPagination(snapshot: object, details: NonNullable<CaptureEvidence["pagination"]>) {
  pagination.set(snapshot, details);
}
export function metaCaptureSummary(wire: { observedAtUtc: string; pageCount: number; paginationComplete: boolean; levels: Record<typeof LEVELS[number], unknown[]> }, fingerprint: string): CaptureEvidence {
  return { fingerprint, observedAtUtc: wire.observedAtUtc, totalPages: wire.pageCount,
    paginationComplete: wire.paginationComplete, requestedPageSize: 1000,
    rowCounts: Object.fromEntries(LEVELS.map(level => [level, wire.levels[level].length])) as CaptureEvidence["rowCounts"],
    ...(pagination.has(wire) ? { pagination: pagination.get(wire) } : {}) };
}
export function getMetaFailureEvidence(error: unknown) {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? safeMetaFailureEvidence(evidence.get(error)) : null;
}
