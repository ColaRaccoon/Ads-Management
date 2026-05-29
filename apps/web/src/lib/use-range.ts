"use client";

import { useEffect, useState } from "react";
import { defaultRange } from "./date-range";

export function useRange() {
  const [range, setRange] = useState(defaultRange(7));

  useEffect(() => {
    const read = () => {
      const params = new URLSearchParams(window.location.search);
      const fallback = defaultRange(7);
      setRange({
        from: params.get("from") ?? fallback.from,
        to: params.get("to") ?? fallback.to
      });
    };
    read();
    window.addEventListener("popstate", read);
    window.addEventListener("rangechange", read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("rangechange", read);
    };
  }, []);

  return range;
}
