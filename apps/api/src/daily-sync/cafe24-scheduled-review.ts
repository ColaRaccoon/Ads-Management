import { PrismaService } from "../common/prisma.service";
import { Prisma } from "@prisma/client";

/** One explicit production handoff from a reviewed day to its following CSV
 * baseline. It grants no provider access and never changes a policy itself. */
export async function reviewedCafe24ScheduledBaseline(db: PrismaService | Prisma.TransactionClient, connectionId: string,
  day: string, policy: { version: number; fromDate: Date; toDate: Date | null;
    primarySource: string; couponInputSource: string | null }, coupon: string) {
  const env = process.env;
  if (env.SUPABASE_DATABASE_PROJECT_REF !== "iygjmosbelbosfxidqxv" ||
      env.SUPABASE_DATABASE_SCHEMA !== "meta_ads" ||
      env.SUPABASE_DATABASE_RUNTIME_USER !== "meta_ads_prod_runtime" ||
      env.RUNTIME_API_TARGET_ID !== "bundle-loopback-api" ||
      connectionId !== "be140e7e-3994-406e-94ff-b50dfc7ac7b2") return false;
  let review: Record<string, unknown>;
  try {
    review = JSON.parse(env.DAILY_SYNC_CAFE24_SCHEDULED_REVIEWED_BASELINE ?? "null");
    if (!review || Array.isArray(review) || Object.keys(review).sort().join() !==
        "connectionId,couponInputSource,fromDate,policyVersion,reviewedDay") return false;
  } catch { return false; }
  if (review.connectionId !== connectionId || review.couponInputSource !== coupon ||
      !Number.isSafeInteger(review.policyVersion) || review.policyVersion !== policy.version ||
      typeof review.fromDate !== "string" || typeof review.reviewedDay !== "string" ||
      !/^\d{4}-\d\d-\d\d$/.test(review.fromDate) ||
      !/^\d{4}-\d\d-\d\d$/.test(review.reviewedDay) ||
      Date.parse(review.fromDate) - Date.parse(review.reviewedDay) !== 86_400_000 ||
      policy.primarySource !== "CSV" || policy.couponInputSource !== null || policy.toDate !== null ||
      policy.fromDate.toISOString().slice(0, 10) !== review.fromDate || day < review.fromDate) return false;
  const date = new Date(`${review.reviewedDay}T00:00:00.000Z`);
  const [prior, coverage, audit] = await Promise.all([
    db.sourcePolicy.findMany({ where: { connectionId, dataKind: "CAFE24_ORDER",
      fromDate: date, toDate: policy.fromDate, primarySource: "API", couponInputSource: coupon } }),
    db.sourceCoverage.findUnique({ where: { connectionId_dataKind_metricDate: {
      connectionId, dataKind: "CAFE24_ORDER", metricDate: date } } }),
    db.securityAuditEvent.findFirst({ where: { action: "SOURCE_POLICY_CHANGED", result: "SUCCESS",
      targetType: "SOURCE_POLICY", AND: [
        { afterJson: { path: ["connectionId"], equals: connectionId } },
        { afterJson: { path: ["day"], equals: review.reviewedDay } }
      ] }, orderBy: { createdAt: "desc" }, select: { afterJson: true } })
  ]);
  const after = audit?.afterJson as Record<string, unknown> | undefined;
  return prior.length === 1 && coverage?.source === "API" &&
    ["COMPLETE_ZERO", "COMPLETE_NONZERO"].includes(coverage.state) &&
    coverage.reconciliationStatus === "CSV_API_INPUTS_REVIEWED" && !!coverage.lastSuccessRunId &&
    !coverage.warningCodes.includes("CAFE24_SHADOW_NOT_PRIMARY") &&
    after?.sourceChoice === "CSV_REVIEWED" && after.couponInputSource === coupon &&
    after.successRunId === coverage.lastSuccessRunId && after.version === prior[0].version;
}
