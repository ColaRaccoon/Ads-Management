"use client";

import { CalendarDays } from "lucide-react";
import { rangePresets } from "@/lib/date-range";
import { usePeriod } from "@/lib/usePeriod";

export function DateRangePicker() {
  const { from, to, setPreset, setRange } = usePeriod();

  return (
    <div className="toolbar" aria-label="기간 선택">
      <div className="segmented">
        {rangePresets.map((preset) => (
          <button key={preset.days} type="button" onClick={() => setPreset(preset.days)}>
            {preset.label}
          </button>
        ))}
      </div>
      <CalendarDays size={18} className="muted" />
      <input className="input" type="date" value={from} onChange={(event) => setRange(event.target.value, to)} />
      <input className="input" type="date" value={to} onChange={(event) => setRange(from, event.target.value)} />
    </div>
  );
}
