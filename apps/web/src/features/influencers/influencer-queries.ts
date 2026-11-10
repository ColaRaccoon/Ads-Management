import { queryOptions } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { STOREFRONT_QUERY_OPTIONS } from "@/lib/storefront-display";

export const influencerResource = "/storefront/influencers";
export const collaborationKey = ["storefront-influencers"] as const;

export type CollaborationInput = {
  influencerName: string;
  feeKrw: number;
  startDate: string;
  endDate: string | null;
  note: string | null;
};

export type Collaboration = CollaborationInput & {
  id: string;
  version: string;
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
