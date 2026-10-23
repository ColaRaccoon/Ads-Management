import { Prisma } from "@prisma/client";
import type { DecisionInput } from "../domain/decision-classifier";

/** Only OVERALL/UNKNOWN with no CPA thresholds: classifier consumes margin's sign only.
 * Keep raw decimal amounts in the decision log; these sentinels must not enter product/adset decisions.
 */
export function overallDashboardDecisionInput(input: {
  purchaseCount: number | null; marginKrw: string | null; dataDays: number;
  ctrLinkPct: number | null; landingPageViews: number | null;
  goodCtrLinkPct: number; goodLandingPageViewCount: number;
}): DecisionInput {
  return {
    ...input, scopeType: "OVERALL", stage: "UNKNOWN",
    marginKrw: input.marginKrw === null ? null : new Prisma.Decimal(input.marginKrw).comparedTo(0),
    spendKrw: 0, cpaKrw: null,
    breakEvenCpaKrw: null, targetCpaKrw: null, watchCpaKrw: null, stopCpaKrw: null
  };
}
