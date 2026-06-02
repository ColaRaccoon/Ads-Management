"use client";

import { RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { defaultRange, presetRange, rangePresets } from "@/lib/date-range";

export function DateRangePicker() {
  const router = useRouter();
  const params = useSearchParams();
  const searchKey = params.toString();
  const fallback = defaultRange(7);
  const from = params.get("from") ?? fallback.from;
  const to = params.get("to") ?? fallback.to;

  useEffect(() => {
    window.dispatchEvent(new Event("rangechange"));
  }, [searchKey]);

  const setRange = (nextFrom: string, nextTo: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("from", nextFrom);
    next.set("to", nextTo);
    router.push(`?${next.toString()}`);
  };

  return (
    <div className="toolbar">
      {rangePresets.map((preset) => (
        <button
          key={preset.days}
          className="button"
          type="button"
          onClick={() => {
            const next = presetRange(preset.days);
            setRange(next.from, next.to);
          }}
        >
          {preset.label}
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
