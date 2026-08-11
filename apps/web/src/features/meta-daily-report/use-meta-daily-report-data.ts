"use client";

import { useQuery } from "@tanstack/react-query";
import { format, parseISO, subDays } from "date-fns";
import { useMemo } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import {
  aggregateProductRows,
  buildPreviousIndexes,
  buildReportProductGroups,
  buildSalesProductIndex,
  filterRows,
  groupRowsByProduct
} from "./report-model";
import type {
  CreativePerformanceRow,
  DeliveryStatusFilter,
  SalesProductPerformance
} from "./types";

type MetaDailyReportDataOptions = {
  reportDate: string;
  query: string;
  deliveryStatus: DeliveryStatusFilter;
  settingsLoaded: boolean;
};

export function useMetaDailyReportData({
  reportDate,
  query,
  deliveryStatus,
  settingsLoaded
}: MetaDailyReportDataOptions) {
  const previousDate = format(subDays(parseISO(reportDate), 1), "yyyy-MM-dd");
  const apiDeliveryStatus = deliveryStatus === "hasSpend" ? "all" : deliveryStatus;
  const current = useQuery({
    queryKey: ["daily-report-creatives", reportDate, query, deliveryStatus],
    queryFn: () => apiGet<CreativePerformanceRow[]>(
      `/metrics/ads/creatives?${rangeQuery(
        { from: reportDate, to: reportDate },
        { q: query, deliveryStatus: apiDeliveryStatus }
      )}`
    ),
    enabled: settingsLoaded
  });
  const previous = useQuery({
    queryKey: ["daily-report-creatives-prev", previousDate, query, deliveryStatus],
    queryFn: () => apiGet<CreativePerformanceRow[]>(
      `/metrics/ads/creatives?${rangeQuery(
        { from: previousDate, to: previousDate },
        { q: query, deliveryStatus: apiDeliveryStatus }
      )}`
    ),
    enabled: settingsLoaded
  });
  const salesPerformance = useQuery({
    queryKey: ["daily-report-sales-product-performance", reportDate, apiDeliveryStatus],
    queryFn: () => apiGet<SalesProductPerformance>(
      `/sales/product-performance?${rangeQuery(
        { from: reportDate, to: reportDate },
        { deliveryStatus: apiDeliveryStatus }
      )}`
    ),
    enabled: settingsLoaded
  });

  // hasSpend is intentionally applied only to current rows. Previous rows remain
  // unfiltered so their values can still be matched to today's positive-spend creatives.
  const currentRows = useMemo(
    () => filterRows(current.data ?? [], deliveryStatus),
    [current.data, deliveryStatus]
  );
  const productGroups = useMemo(() => groupRowsByProduct(currentRows), [currentRows]);
  const salesProductIndex = useMemo(
    () => buildSalesProductIndex(salesPerformance.data?.rows ?? []),
    [salesPerformance.data?.rows]
  );
  const reportGroups = useMemo(
    () => buildReportProductGroups(
      productGroups,
      salesPerformance.data?.rows ?? [],
      salesProductIndex,
      query
    ),
    [productGroups, query, salesPerformance.data?.rows, salesProductIndex]
  );
  const reportTotals = useMemo(() => aggregateProductRows(currentRows), [currentRows]);
  const previousIndexes = useMemo(
    () => buildPreviousIndexes(previous.data ?? []),
    [previous.data]
  );
  const isLoading = current.isLoading || previous.isLoading || salesPerformance.isLoading || !settingsLoaded;

  return {
    previousDate,
    currentRows,
    previousRows: previous.data ?? [],
    salesData: salesPerformance.data,
    reportGroups,
    reportTotals,
    previousIndexes,
    isLoading,
    currentIsError: current.isError,
    previousIsError: previous.isError,
    salesIsError: salesPerformance.isError,
    salesIsLoading: salesPerformance.isLoading
  };
}
