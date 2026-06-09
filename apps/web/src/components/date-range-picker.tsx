"use client";

import { RefreshCw } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  DateRange,
  defaultRangeForPath,
  presetRange,
  rangePresets,
  readCachedRange,
  writeCachedRange
} from "@/lib/date-range";

export function DateRangePicker() {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const searchKey = params.toString();
  const [cachedRange, setCachedRange] = useState<DateRange | null>(null);
  const fallback = cachedRange ?? defaultRangeForPath(pathname);
  const from = params.get("from") ?? fallback.from;
  const to = params.get("to") ?? fallback.to;
  const hasQueryRange = Boolean(params.get("from") && params.get("to"));

  useEffect(() => {
    const restored = readCachedRange(pathname);
    setCachedRange(restored);

    if (!hasQueryRange) {
      const nextRange = restored ?? (pathname === "/ads" ? defaultRangeForPath(pathname) : null);
      if (nextRange) {
        writeCachedRange(pathname, nextRange);
        const next = new URLSearchParams(searchKey);
        next.set("from", nextRange.from);
        next.set("to", nextRange.to);
        router.replace(`?${next.toString()}`);
        return;
      }
    }

    if (hasQueryRange) {
      writeCachedRange(pathname, { from, to });
    }
    window.dispatchEvent(new Event("rangechange"));
  }, [from, hasQueryRange, pathname, router, searchKey, to]);

  const setRange = (nextFrom: string, nextTo: string) => {
    const nextRange = { from: nextFrom, to: nextTo };
    setCachedRange(nextRange);
    writeCachedRange(pathname, nextRange);
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
