"use client";

import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths
} from "date-fns";
import {
  DateRange,
  defaultRangeForPath,
  presetRange,
  rangePresets,
  readCachedRange,
  writeCachedRange
} from "@/lib/date-range";

const weekLabels = ["일", "월", "화", "수", "목", "금", "토"] as const;

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
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(parseISO(to)));
  const [dragAnchor, setDragAnchor] = useState<string | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const dragAnchorRef = useRef<string | null>(null);
  const skipClickRef = useRef(false);
  const currentRange = useMemo(() => normalizeRange(from, to), [from, to]);
  const previewRange = useMemo(
    () => (dragAnchor && hoverDate ? normalizeRange(dragAnchor, hoverDate) : currentRange),
    [currentRange, dragAnchor, hoverDate]
  );
  const calendarDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(viewMonth), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(viewMonth), { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  }, [viewMonth]);

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

  useEffect(() => {
    if (!calendarOpen) {
      return;
    }

    const closeCalendar = (event: PointerEvent) => {
      if (pickerRef.current && event.target instanceof Node && !pickerRef.current.contains(event.target)) {
        dragAnchorRef.current = null;
        setDragAnchor(null);
        setHoverDate(null);
        setCalendarOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dragAnchorRef.current = null;
        setDragAnchor(null);
        setHoverDate(null);
        setCalendarOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeCalendar);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeCalendar);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [calendarOpen]);

  const setRange = (nextFrom: string, nextTo: string) => {
    const nextRange = normalizeRange(nextFrom, nextTo);
    setCachedRange(nextRange);
    writeCachedRange(pathname, nextRange);
    const next = new URLSearchParams(params.toString());
    next.set("from", nextRange.from);
    next.set("to", nextRange.to);
    router.push(`?${next.toString()}`);
  };

  const openCalendar = () => {
    setViewMonth(startOfMonth(parseISO(to)));
    setCalendarOpen((isOpen) => !isOpen);
  };

  const applyRange = (range: DateRange) => {
    setRange(range.from, range.to);
    dragAnchorRef.current = null;
    setDragAnchor(null);
    setHoverDate(null);
    setCalendarOpen(false);
  };

  const beginSelection = (dateValue: string) => {
    dragAnchorRef.current = dateValue;
    setDragAnchor(dateValue);
    setHoverDate(dateValue);
  };

  const previewSelection = (dateValue: string) => {
    if (dragAnchorRef.current) {
      setHoverDate(dateValue);
    }
  };

  const finishSelection = (dateValue: string) => {
    const start = dragAnchorRef.current ?? dragAnchor ?? dateValue;
    skipClickRef.current = true;
    window.setTimeout(() => {
      skipClickRef.current = false;
    }, 0);
    applyRange(normalizeRange(start, dateValue));
  };

  const cancelSelection = () => {
    dragAnchorRef.current = null;
    setDragAnchor(null);
    setHoverDate(null);
  };

  return (
    <div className="toolbar date-toolbar">
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
      <div className="date-picker" ref={pickerRef}>
        <button
          className={`button date-trigger${calendarOpen ? " active" : ""}`}
          type="button"
          aria-expanded={calendarOpen}
          aria-haspopup="dialog"
          onClick={openCalendar}
        >
          <CalendarDays size={16} />
          <span>{formatRangeLabel(currentRange)}</span>
        </button>
        {calendarOpen ? (
          <div className="date-popover" role="dialog" aria-label="날짜 선택">
            <div className="calendar-head">
              <button
                className="icon-button calendar-nav"
                type="button"
                title="이전 달"
                onClick={() => setViewMonth((month) => subMonths(month, 1))}
              >
                <ChevronLeft size={16} />
              </button>
              <strong>{format(viewMonth, "yyyy년 M월")}</strong>
              <button
                className="icon-button calendar-nav"
                type="button"
                title="다음 달"
                onClick={() => setViewMonth((month) => addMonths(month, 1))}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="calendar-weekdays" aria-hidden="true">
              {weekLabels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {calendarDays.map((day) => {
                const dateValue = formatDateValue(day);
                const selected = isInRange(dateValue, previewRange);
                const edge = selected && (dateValue === previewRange.from || dateValue === previewRange.to);
                const single = previewRange.from === previewRange.to && dateValue === previewRange.from;
                const outsideMonth = !isSameMonth(day, viewMonth);
                const className = [
                  "calendar-day",
                  outsideMonth ? "outside" : "",
                  selected ? "selected" : "",
                  edge ? "edge" : "",
                  single ? "single" : ""
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <button
                    key={dateValue}
                    className={className}
                    type="button"
                    aria-label={`선택 날짜 ${formatReadableDate(dateValue)}`}
                    aria-pressed={selected}
                    onClick={() => {
                      if (skipClickRef.current) {
                        return;
                      }
                      applyRange({ from: dateValue, to: dateValue });
                    }}
                    onPointerCancel={cancelSelection}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      beginSelection(dateValue);
                    }}
                    onPointerEnter={() => previewSelection(dateValue)}
                    onPointerMove={() => previewSelection(dateValue)}
                    onPointerUp={() => finishSelection(dateValue)}
                  >
                    {format(day, "d")}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <button className="icon-button" type="button" title="새로고침" onClick={() => router.refresh()}>
        <RefreshCw size={16} />
      </button>
    </div>
  );
}

function normalizeRange(start: string, end: string): DateRange {
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

function formatDateValue(date: Date) {
  return format(date, "yyyy-MM-dd");
}

function formatReadableDate(value: string) {
  return format(parseISO(value), "yyyy.MM.dd");
}

function formatRangeLabel(range: DateRange) {
  if (range.from === range.to) {
    return formatReadableDate(range.from);
  }
  return `${formatReadableDate(range.from)} - ${formatReadableDate(range.to)}`;
}

function isInRange(dateValue: string, range: DateRange) {
  return range.from <= dateValue && dateValue <= range.to;
}
