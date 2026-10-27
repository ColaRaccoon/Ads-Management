"use client";

import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { googleFilterQuery, readGoogleDateFilters } from "@/lib/google-date-filters";
import { DateRangeControl } from "./date-range-picker";

export function GoogleDateRangePicker() {
  const filters = readGoogleDateFilters(useSearchParams().toString());
  const queryClient = useQueryClient();

  return <DateRangeControl
    value={filters}
    onChange={(range) => {
      const search = googleFilterQuery({ ...filters, ...range });
      window.history.replaceState(null, "", `${window.location.pathname}?${search}${window.location.hash}`);
    }}
    onRefresh={() => { void queryClient.invalidateQueries({ queryKey: ["google"] }); }}
  />;
}
