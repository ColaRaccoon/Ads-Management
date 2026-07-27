"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  type DailyCategoryPopoverCloseReason,
  shouldRestoreDailyCategoryTriggerFocus
} from "@/lib/coupang-daily-category";
import type { CoupangDailyReportCategorySummary } from "@/types/coupang";

type DailyCategoryFilterProps = {
  categories: CoupangDailyReportCategorySummary[];
  selected: ReadonlySet<string>;
  includeUncategorized: boolean;
  hasQuery: boolean;
  loading: boolean;
  error: boolean;
  manageButtonRef: RefObject<HTMLButtonElement | null>;
  onSelectedChange: (ids: Set<string>) => void;
  onIncludeUncategorizedChange: (value: boolean) => void;
  onReset: () => void;
  onRetry: () => void;
  onManage: () => void;
};

export function DailyCategoryFilter({
  categories,
  selected,
  includeUncategorized,
  hasQuery,
  loading,
  error,
  manageButtonRef,
  onSelectedChange,
  onIncludeUncategorizedChange,
  onReset,
  onRetry,
  onManage
}: DailyCategoryFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draftSelected, setDraftSelected] = useState<Set<string>>(new Set());
  const [draftUncategorized, setDraftUncategorized] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocusFrameRef = useRef<number | null>(null);
  const popoverId = "coupang-daily-category-popover";

  const selectedCategories = categories.filter((category) => selected.has(category.id));
  const normalizedSearch = search.trim().toLocaleLowerCase("ko-KR");
  const visibleCategories = useMemo(
    () => categories.filter((category) => (
      category.displayName.toLocaleLowerCase("ko-KR").includes(normalizedSearch)
    )),
    [categories, normalizedSearch]
  );

  const openPopover = () => {
    setDraftSelected(new Set(selected));
    setDraftUncategorized(includeUncategorized);
    setSearch("");
    setOpen(true);
  };

  const closePopover = (reason: DailyCategoryPopoverCloseReason) => {
    setOpen(false);
    setSearch("");
    if (!shouldRestoreDailyCategoryTriggerFocus(reason)) return;
    if (restoreFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFocusFrameRef.current);
    }
    restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
      restoreFocusFrameRef.current = null;
      triggerRef.current?.focus();
    });
  };

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePopover("outside");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePopover("escape");
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => () => {
    if (restoreFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFocusFrameRef.current);
    }
  }, []);

  const toggleDraft = (id: string) => {
    setDraftSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleVisible = (checked: boolean) => {
    setDraftSelected((current) => {
      const next = new Set(current);
      for (const category of visibleCategories) {
        checked ? next.add(category.id) : next.delete(category.id);
      }
      return next;
    });
  };

  const applyDraft = () => {
    onSelectedChange(new Set(draftSelected));
    onIncludeUncategorizedChange(draftUncategorized);
    closePopover("apply");
  };

  const removeSelected = (id: string) => {
    const next = new Set(selected);
    next.delete(id);
    onSelectedChange(next);
  };

  const selectionCount = selected.size + (includeUncategorized ? 1 : 0);

  return (
    <section className="coupang-daily-category-filter coupang-daily-no-print" aria-label="리포트 범위">
      <strong>리포트 범위</strong>
      <div className="coupang-daily-category-picker" ref={rootRef}>
        <button
          ref={triggerRef}
          type="button"
          className="button coupang-daily-category-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={() => open ? closePopover("trigger") : openPopover()}
        >
          {selectionCount > 0 ? `${selectionCount}개 범위 선택` : "카테고리 선택"}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {open ? (
          <div
            id={popoverId}
            className="coupang-daily-category-popover"
            role="dialog"
            aria-modal="false"
            aria-label="리포트 카테고리 선택"
          >
            <label className="coupang-daily-category-search">
              <Search size={14} aria-hidden="true" />
              <span className="coupang-daily-visually-hidden">카테고리 검색</span>
              <input
                ref={searchRef}
                type="search"
                value={search}
                placeholder="카테고리 검색"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="coupang-daily-category-popover-actions">
              <button
                type="button"
                disabled={loading || error || visibleCategories.length === 0}
                onClick={() => toggleVisible(true)}
              >
                {normalizedSearch ? "검색 결과 전체 선택" : "전체 선택"}
              </button>
              <button
                type="button"
                disabled={loading || error || visibleCategories.length === 0}
                onClick={() => toggleVisible(false)}
              >
                {normalizedSearch ? "검색 결과 전체 해제" : "전체 해제"}
              </button>
            </div>
            <div className="coupang-daily-category-options">
              {loading ? <p role="status">카테고리를 불러오는 중입니다.</p> : null}
              {!loading && error ? (
                <div role="alert">
                  <p>카테고리를 불러오지 못했습니다.</p>
                  <button type="button" onClick={onRetry}>다시 시도</button>
                </div>
              ) : null}
              {!loading && !error && categories.length === 0 ? (
                <div className="coupang-daily-category-state">
                  <p>아직 만든 리포트 카테고리가 없습니다.</p>
                  <button
                    type="button"
                    onClick={() => {
                      closePopover("manage");
                      onManage();
                    }}
                  >
                    첫 카테고리 만들기
                  </button>
                </div>
              ) : null}
              {!loading && !error && categories.length > 0 && visibleCategories.length === 0 ? (
                <p>검색 결과가 없습니다.</p>
              ) : null}
              {!loading && !error ? visibleCategories.map((category) => (
                <label key={category.id}>
                  <input
                    type="checkbox"
                    checked={draftSelected.has(category.id)}
                    onChange={() => toggleDraft(category.id)}
                  />
                  <span>{category.displayName}</span>
                  <small>{category.activeMemberCount}</small>
                </label>
              )) : null}
            </div>
            <label className="coupang-daily-category-uncategorized">
              <input
                type="checkbox"
                checked={draftUncategorized}
                onChange={(event) => setDraftUncategorized(event.target.checked)}
              />
              미분류 제품
            </label>
            <footer>
              <span>{draftSelected.size + (draftUncategorized ? 1 : 0)}개 선택</span>
              <button type="button" className="button primary" onClick={applyDraft}>
                <Check size={14} aria-hidden="true" />
                완료
              </button>
            </footer>
          </div>
        ) : null}
      </div>
      <div className="coupang-daily-category-chips" aria-label="선택된 리포트 범위">
        {selectedCategories.map((category) => (
          <button
            key={category.id}
            type="button"
            className="coupang-daily-category-chip"
            aria-label={`${category.displayName} 선택 해제`}
            onClick={() => removeSelected(category.id)}
          >
            {category.displayName}
            <X size={12} aria-hidden="true" />
          </button>
        ))}
        {includeUncategorized ? (
          <button
            type="button"
            className="coupang-daily-category-chip"
            aria-label="미분류 제품 선택 해제"
            onClick={() => onIncludeUncategorizedChange(false)}
          >
            미분류 제품
            <X size={12} aria-hidden="true" />
          </button>
        ) : null}
        {selectionCount === 0 ? <span className="coupang-daily-category-all">전체 제품</span> : null}
      </div>
      <button
        type="button"
        className="button"
        disabled={selectionCount === 0 && !hasQuery}
        onClick={onReset}
      >
        초기화
      </button>
      <button
        ref={manageButtonRef}
        type="button"
        className="button"
        onClick={() => {
          closePopover("manage");
          onManage();
        }}
      >
        카테고리 관리
      </button>
      <small>선택한 카테고리의 제품을 합쳐 표시하며 중복 제품은 한 번만 계산합니다.</small>
    </section>
  );
}
