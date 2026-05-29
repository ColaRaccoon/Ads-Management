"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { shiftDate, todayString } from "./format";

export function usePeriod() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const to = searchParams.get("to") ?? todayString();
  const from = searchParams.get("from") ?? shiftDate(to, -6);

  function setPreset(days: number) {
    const nextTo = todayString();
    setRange(shiftDate(nextTo, -(days - 1)), nextTo);
  }

  function setRange(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("from", nextFrom);
    params.set("to", nextTo);
    router.replace(`${pathname}?${params.toString()}`);
  }

  return { from, to, setPreset, setRange };
}
