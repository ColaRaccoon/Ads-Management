import { queryOptions } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { STOREFRONT_QUERY_OPTIONS } from "@/lib/storefront-display";

export const influencerResource = "/storefront/influencers";
export const collaborationKey = ["storefront-influencers"] as const;

export type CollaborationInput = {
  nickname: string;
  managerName: string;
  productId: string;
  feeKrw: number;
  startDate: string;
  note: string | null;
};

export type Collaboration = Omit<CollaborationInput, "managerName" | "productId"> & {
  id: string;
  version: string;
  managerName: string | null;
  productId: string | null;
  productName: string | null;
  numberingRequired: boolean;
  materialCount: number;
  adSpendKrw: number | null;
  adMarginKrw: number | null;
  netPerformanceKrw: number | null;
  dataThrough: string | null;
  aggregatedAt: string | null;
  creativeCount: number;
};

type Creative = {
  creativeName: string;
  adSpendKrw: number | null;
  adMarginKrw: number | null;
  dataThrough: string;
};

type CollaborationPage = { items: Collaboration[]; page: number; hasMore: boolean };

export type InfluencerDailyRow = Pick<Collaboration,
  "id" | "managerName" | "nickname" | "productName" | "adSpendKrw" | "adMarginKrw" | "creativeCount">;

export type NumberedMaterial = { creativeId: string; creativeName: string; materialNo: string };

const queryDefaults = {
  ...STOREFRONT_QUERY_OPTIONS,
  staleTime: 30_000,
  refetchOnMount: true
} as const;

export function influencerListOptions(page: number) {
  return queryOptions({
    ...queryDefaults,
    queryKey: [...collaborationKey, page],
    queryFn: () => apiGet<CollaborationPage>(`${influencerResource}?page=${page}`)
  });
}

export function influencerCreativesOptions({ id, version, aggregatedAt }: Collaboration) {
  return queryOptions({
    ...queryDefaults,
    queryKey: ["storefront-influencer-creatives", id, version, aggregatedAt],
    queryFn: () => apiGet<{ items: Creative[] }>(`${influencerResource}/${encodeURIComponent(id)}/creatives`)
  });
}

export function influencerDailyOptions(date: string, managerName: string, page: number) {
  const query = new URLSearchParams({ date, page: String(page) });
  if (managerName) query.set("managerName", managerName);
  return queryOptions({
    ...queryDefaults,
    queryKey: [...collaborationKey, "daily", date, managerName, page],
    queryFn: () => apiGet<{ items: InfluencerDailyRow[]; managers: string[]; hasMore: boolean }>(`${influencerResource}/daily?${query}`)
  });
}
