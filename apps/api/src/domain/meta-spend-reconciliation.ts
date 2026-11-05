import { Prisma } from "@prisma/client";

export const META_SPEND_WARNING = "META_SPEND_DIFFERENCE_WITHIN_10_USD";
export const META_SPEND_LIMIT_USD = "10.0000";
export const metaSpendWithinTolerance = (a: Prisma.Decimal.Value, b: Prisma.Decimal.Value) =>
  new Prisma.Decimal(a).minus(b).abs().lte(META_SPEND_LIMIT_USD);
type Row = Record<string, unknown>;
type Levels = { ad: Row[]; adset: Row[]; campaign: Row[]; ad_account: Row[] };
const boundaries = ["adToAdset", "adsetToCampaign", "adToCampaign", "campaignToAccount", "adsetToAccount", "adToAccount"] as const;
export type MetaSpendReconciliation = {
  version: 1; policy: "DAILY_HIERARCHY_L1_USD_10"; day: string; limitUsd: "10.0000";
  adSpendUsd: string; adsetSpendUsd: string; campaignSpendUsd: string; accountSpendUsd: string;
  absoluteDifferencesUsd: Record<typeof boundaries[number], string>; maxAbsoluteDifferenceUsd: string;
  monetaryDifferencesAllocated: false;
};
const amount = (row: Row) => {
  const value = row.amount_spent as { unit?: unknown; value?: unknown } | undefined;
  if (!value || value.unit !== "USD" || typeof value.value !== "string" || !/^(0|[1-9]\d{0,9})(\.\d{1,4})?$/.test(value.value))
    throw Error("INVALID_META_SPEND");
  return new Prisma.Decimal(value.value);
};
const sum = (rows: Row[]) => rows.reduce((n, row) => n.plus(amount(row)), new Prisma.Decimal(0));
/** L1 per hierarchy boundary prevents both per-entity accumulation and cancellation.
 * The maximum is used because the same discrepancy appears at multiple boundaries. */
export function metaSpendHierarchyEvidence(levels: Levels, day: string): MetaSpendReconciliation {
  if (levels.ad_account.length !== 1) throw Error("INVALID_META_SPEND_SCOPE");
  const l1 = (parents: Row[], children: Row[], field: string) => parents.reduce((n, parent) =>
    n.plus(amount(parent).minus(sum(children.filter(row => row[field] === parent.id))).abs()), new Prisma.Decimal(0));
  const ad = sum(levels.ad), adset = sum(levels.adset), campaign = sum(levels.campaign), account = sum(levels.ad_account);
  const differences = {
    adToAdset: l1(levels.adset, levels.ad, "adset_id"),
    adsetToCampaign: l1(levels.campaign, levels.adset, "campaign_id"),
    adToCampaign: l1(levels.campaign, levels.ad, "campaign_id"),
    campaignToAccount: campaign.minus(account).abs(), adsetToAccount: adset.minus(account).abs(), adToAccount: ad.minus(account).abs()
  };
  const maximum = Prisma.Decimal.max(...Object.values(differences));
  return { version: 1, policy: "DAILY_HIERARCHY_L1_USD_10", day, limitUsd: META_SPEND_LIMIT_USD,
    adSpendUsd: ad.toFixed(4), adsetSpendUsd: adset.toFixed(4), campaignSpendUsd: campaign.toFixed(4), accountSpendUsd: account.toFixed(4),
    absoluteDifferencesUsd: Object.fromEntries(boundaries.map(key => [key, differences[key].toFixed(4)])) as MetaSpendReconciliation["absoluteDifferencesUsd"],
    maxAbsoluteDifferenceUsd: maximum.toFixed(4), monetaryDifferencesAllocated: false };
}
export function validMetaSpendReconciliation(value: unknown): value is MetaSpendReconciliation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as MetaSpendReconciliation;
  if (Object.keys(v).sort().join() !== "absoluteDifferencesUsd,accountSpendUsd,adSpendUsd,adsetSpendUsd,campaignSpendUsd,day,limitUsd,maxAbsoluteDifferenceUsd,monetaryDifferencesAllocated,policy,version" ||
    v.version !== 1 || v.policy !== "DAILY_HIERARCHY_L1_USD_10" || v.limitUsd !== META_SPEND_LIMIT_USD || v.monetaryDifferencesAllocated !== false ||
    typeof v.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.day) || !v.absoluteDifferencesUsd ||
    Object.keys(v.absoluteDifferencesUsd).sort().join() !== [...boundaries].sort().join()) return false;
  const values = [v.adSpendUsd, v.adsetSpendUsd, v.campaignSpendUsd, v.accountSpendUsd, v.maxAbsoluteDifferenceUsd, ...Object.values(v.absoluteDifferencesUsd)];
  if (!values.every(n => typeof n === "string" && /^(0|[1-9]\d{0,13})\.\d{4}$/.test(n))) return false;
  return new Prisma.Decimal(v.maxAbsoluteDifferenceUsd).eq(Prisma.Decimal.max(...Object.values(v.absoluteDifferencesUsd))) &&
    new Prisma.Decimal(v.maxAbsoluteDifferenceUsd).gt(0) && new Prisma.Decimal(v.maxAbsoluteDifferenceUsd).lte(META_SPEND_LIMIT_USD) &&
    new Prisma.Decimal(v.absoluteDifferencesUsd.adToAdset).gte(new Prisma.Decimal(v.adSpendUsd).minus(v.adsetSpendUsd).abs()) &&
    new Prisma.Decimal(v.absoluteDifferencesUsd.adToCampaign).gte(new Prisma.Decimal(v.adSpendUsd).minus(v.campaignSpendUsd).abs()) &&
    new Prisma.Decimal(v.absoluteDifferencesUsd.adsetToCampaign).gte(new Prisma.Decimal(v.adsetSpendUsd).minus(v.campaignSpendUsd).abs()) &&
    ([['adSpendUsd','adToAccount'],['adsetSpendUsd','adsetToAccount'],['campaignSpendUsd','campaignToAccount']] as const)
      .every(([total, boundary]) => new Prisma.Decimal(v[total]).minus(v.accountSpendUsd).abs().eq(v.absoluteDifferencesUsd[boundary]));
}
