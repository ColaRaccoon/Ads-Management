"use client";

import { RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { format, subDays } from "date-fns";

const presets = [1, 3, 7, 14];

export function DateRangePicker() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") ?? format(subDays(new Date(), 6), "yyyy-MM-dd");
  const to = params.get("to") ?? format(new Date(), "yyyy-MM-dd");

  const setRange = (nextFrom: string, nextTo: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("from", nextFrom);
    next.set("to", nextTo);
    router.push(`?${next.toString()}`);
    window.setTimeout(() => window.dispatchEvent(new Event("rangechange")), 0);
  };

  return (
    <div className="toolbar">
      {presets.map((days) => (
        <button
          key={days}
          className="button"
          type="button"
          onClick={() => setRange(format(subDays(new Date(), days - 1), "yyyy-MM-dd"), format(new Date(), "yyyy-MM-dd"))}
        >
          {days}일
        </button>
      ))}
      <input className="input" type="date" value={from} onChange={(event) => setRange(event.target.value, to)} />
      <input className="input" type="date" value={to} onChange={(event) => setRange(from, event.target.value)} />
      <button className="icon-button" type="button" title="새로고침" onClick={() => router.refresh()}>
        <RefreshCw size={16} />
      </button>
    </div>
  );
}
