import { Prisma } from "@prisma/client";
import { ProviderFailure } from "./bounded-request";

/** Global old-app return gate, evaluated after pause/drain and scoped CAS rollback.
 * Retained API history blocks old-app return: legacy restore/delete can update
 * noncurrent API rows without a source predicate. CSV values and nullable API
 * fields are never rewritten or discarded to satisfy the old client.
 * API policies are checked only in the explicit manifest connection/date scope.
 * API current/history rows and active writers are checked globally, so unowned
 * API rows still block old-app return. Closed/out-of-scope policies are untouched.
 * This read-only gate does not pause writers or perform the rollback itself.
 */
export async function inspectOldAppRollbackReadiness(tx: Prisma.TransactionClient,
  containment: { stopConfirmed: boolean; schedulesPausedConfirmed: boolean;
    policyScope?: { connectionIds: string[]; fromDate: Date; toDate: Date } }) {
  const scope = containment.policyScope;
  const validScope = scope !== undefined && Array.isArray(scope.connectionIds) &&
    scope.connectionIds.length > 0 && scope.connectionIds.length <= 1000 &&
    scope.connectionIds.every(id => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id)) &&
    scope.fromDate instanceof Date && scope.toDate instanceof Date &&
    Number.isFinite(scope.fromDate.getTime()) && Number.isFinite(scope.toDate.getTime()) && scope.fromDate <= scope.toDate;
  const [enabledConnections, liveLeases, runningRuns, apiPolicies, cafeCurrent,
    metaAdsetCurrent, metaAdCurrent, googleCurrent, cafeHistory, metaAdsetHistory,
    metaAdHistory, googleHistory] = await Promise.all([
    tx.sourceConnection.count({ where: { enabled: true } }),
    tx.syncLease.count({ where: { expiresAt: { gt: new Date() } } }),
    tx.syncRun.count({ where: { status: "RUNNING" } }),
    validScope ? tx.sourcePolicy.count({ where: { primarySource: "API",
      connectionId: { in: scope!.connectionIds }, fromDate: { lte: scope!.toDate },
      OR: [{ toDate: null }, { toDate: { gt: scope!.fromDate } }] } }) : Promise.resolve(0),
    tx.cafe24OrderLine.count({ where: { source: "API", isCurrent: true } }),
    tx.metaAdsetDailyMetric.count({ where: { source: "API", isCurrent: true } }),
    tx.metaAdDailyMetric.count({ where: { source: "API", isCurrent: true } }),
    tx.googleCampaignDailyCost.count({ where: { source: "API", isCurrent: true } }),
    tx.cafe24OrderLine.count({ where: { source: "API", isCurrent: false } }),
    tx.metaAdsetDailyMetric.count({ where: { source: "API", isCurrent: false } }),
    tx.metaAdDailyMetric.count({ where: { source: "API", isCurrent: false } }),
    tx.googleCampaignDailyCost.count({ where: { source: "API", isCurrent: false } })
  ]);
  const reasons: string[] = [];
  if (!validScope) reasons.push("POLICY_SCOPE_NOT_CONFIRMED");
  if (containment.stopConfirmed !== true || containment.schedulesPausedConfirmed !== true)
    reasons.push("CONTAINMENT_NOT_CONFIRMED");
  if (enabledConnections !== 0 || liveLeases !== 0 || runningRuns !== 0)
    reasons.push("WRITERS_NOT_DRAINED");
  if (apiPolicies !== 0) reasons.push("API_POLICY_REMAINS");
  if (cafeCurrent + metaAdsetCurrent + metaAdCurrent + googleCurrent !== 0)
    reasons.push("API_CURRENT_REMAINS");
  if (cafeHistory + metaAdsetHistory + metaAdHistory + googleHistory !== 0)
    reasons.push("API_HISTORY_REMAINS");
  return { ready: reasons.length === 0, reasons, counts: { enabledConnections,
    liveLeases, runningRuns, apiPolicies, cafeCurrent, metaAdsetCurrent, metaAdCurrent, googleCurrent,
    cafeHistory, metaAdsetHistory, metaAdHistory, googleHistory },
    retainedApiHistoryAllowed: false, policiesOutsideManifestScopeUnchanged: true, dataWrites: 0 as const };
}

export async function assertOldAppRollbackReady(tx: Prisma.TransactionClient,
  containment: { stopConfirmed: boolean; schedulesPausedConfirmed: boolean;
    policyScope?: { connectionIds: string[]; fromDate: Date; toDate: Date } }) {
  const result = await inspectOldAppRollbackReadiness(tx, containment);
  if (!result.ready) throw new ProviderFailure("SOURCE_SELECTION_REQUIRED", false,
    null, null, "OLD_APP_ROLLBACK_NOT_READY");
  return result;
}
