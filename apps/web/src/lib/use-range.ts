"use client";

import { useEffect, useState } from "react";
import { defaultRangeForPath, readCachedRange } from "./date-range";

export function useRange() {
  const [range, setRange] = useState(readRange);

  useEffect(() => {
    const read = () => setRange(readRange());
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

function readRange() {
  if (typeof window === "undefined") {
    return defaultRangeForPath();
  }
  const fallback = readCachedRange(window.location.pathname) ?? defaultRangeForPath(window.location.pathname);
  const params = new URLSearchParams(window.location.search);
  return {
    from: params.get("from") ?? fallback.from,
    to: params.get("to") ?? fallback.to
  };
}
