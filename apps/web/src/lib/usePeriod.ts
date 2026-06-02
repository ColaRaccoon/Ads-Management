"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { defaultRange, presetRange } from "./date-range";

export function usePeriod() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const fallback = defaultRange(7);
  const to = searchParams.get("to") ?? fallback.to;
  const from = searchParams.get("from") ?? fallback.from;

  function setPreset(days: number) {
    const next = presetRange(days);
    setRange(next.from, next.to);
  }

  function setRange(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("from", nextFrom);
    params.set("to", nextTo);
    router.replace(`${pathname}?${params.toString()}`);
  }

  return { from, to, setPreset, setRange };
}
