"use client";

import { useEffect, useState } from "react";
import { defaultRange } from "./date-range";

export function useRange() {
  const [range, setRange] = useState(readRange);

  useEffect(() => {
    const read = () => setRange(readRange());
    window.addEventListener("popstate", read);
    window.addEventListener("rangechange", read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("rangechange", read);
    };
  }, []);

  return range;
}

function readRange() {
  const fallback = defaultRange(7);
  if (typeof window === "undefined") {
    return fallback;
  }
  const params = new URLSearchParams(window.location.search);
  return {
    from: params.get("from") ?? fallback.from,
    to: params.get("to") ?? fallback.to
  };
}
