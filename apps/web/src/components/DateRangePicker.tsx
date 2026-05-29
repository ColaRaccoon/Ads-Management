"use client";

import { CalendarDays } from "lucide-react";
import { usePeriod } from "@/lib/usePeriod";

export function DateRangePicker() {
  const { from, to, setPreset, setRange } = usePeriod();
  const presets = [1, 3, 7, 14];

  return (
    <div className="toolbar" aria-label="기간 선택">
      <div className="segmented">
        {presets.map((days) => (
          <button key={days} type="button" onClick={() => setPreset(days)}>
            {days}일
          </button>
        ))}
      </div>
      <CalendarDays size={18} className="muted" />
      <input className="input" type="date" value={from} onChange={(event) => setRange(event.target.value, to)} />
      <input className="input" type="date" value={to} onChange={(event) => setRange(from, event.target.value)} />
    </div>
  );
}
