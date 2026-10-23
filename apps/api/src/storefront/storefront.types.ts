export type Money = string | null;
export type StorefrontChannel = {
  provider: "CAFE24" | "META" | "GOOGLE" | "KAKAO";
  amount: Money; currency: string; spendKrw: Money; complete: boolean;
  state: string; missingDates: string[]; warningCodes: string[];
};
export type StorefrontCoverage = {
  connectionId: string; provider: string; account: string; dataKind: string; date: string;
  currency: string; timeZone: string; selectedSource: string | null; state: string;
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastAttemptStatus: string | null;
  lastSuccessRunId: string | null; rowCount: number | null; amount: Money;
  complete: boolean; warningCodes: string[];
};
export type StorefrontConnection = {
  id: string; provider: string; displayName: string; externalAccountId: string;
  currencyCode: string; timeZone: string; accessState: string; enabled: boolean;
  updatedAt: string; credentialExpiresAt: string | null; reconnectRequired: boolean;
  cadenceDays: number; latestAttempt: { id: string; status: string; at: string | null; safeErrorCode: string | null } | null;
  lastSuccessAt: string | null; completedDates: string[]; stale: boolean;
};
export type StorefrontSummary = {
  from: string; to: string; asOf: string | null; complete: boolean;
  missingSources: string[]; missingDates: string[]; currencyStatus: string;
  totals: { revenueKrw: Money; knownSpendKrw: Money; totalSpendKrw: Money; mer: Money };
  channels: StorefrontChannel[];
  daily: { date: string; revenueKrw: Money; metaSpendUsd: Money; metaSpendKrw: Money;
    googleSpend: Money; googleSpendKrw: Money; knownSpendKrw: Money; totalSpendKrw: Money; complete: boolean }[];
  googleCampaigns: { connectionId: string; date: string; campaignId: string; campaignName: string;
    channelType: string; costMicros: string; amount: string; currency: string; impressions: string; clicks: string; fetchedAt: string }[];
  coverage: StorefrontCoverage[]; connections: StorefrontConnection[];
  exchangeRates: { date: string; rate: string; sourceDate: string; provider: string; fallbackType: string; fetchedAt: string;
    productId?: string; productDisplayName?: string; effectiveTo?: string | null }[];
  warningCodes: string[];
};
