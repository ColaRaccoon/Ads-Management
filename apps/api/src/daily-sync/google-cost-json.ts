/** A transport boundary for Google int64 measures; never pass bigint to JSON.stringify. */
export function serializeGoogleCampaignCost(row: {
  campaignId: string; campaignName: string; channelType: string;
  costMicros: bigint; impressions: bigint; clicks: bigint;
}) {
  if (row.costMicros < 0n || row.impressions < 0n || row.clicks < 0n)
    throw new Error("Invalid Google measure");
  return {
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    channelType: row.channelType,
    costMicros: row.costMicros.toString(),
    impressions: row.impressions.toString(),
    clicks: row.clicks.toString(),
    displayCost: { value: ((row.costMicros + 500_000n) / 1_000_000n).toString(),
      currencyCode: "KRW" as const }
  };
}
