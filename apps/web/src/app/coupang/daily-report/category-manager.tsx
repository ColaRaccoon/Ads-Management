"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  apiDelete,
  apiErrorCode,
  apiErrorMessage,
  apiGet,
  apiPatch,
  apiPost,
  apiPut
} from "@/lib/api";
import type {
  CoupangDailyReportCategory,
  CoupangDailyReportCategoryCatalogResponse,
  CoupangDailyReportCategoryProductOption
} from "@/types/coupang";
import { categoryTreeState } from "@/lib/coupang-daily-category";

type DailyCategoryManagerProps = {
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onCategoryDeactivated: (categoryId: string) => {
    invalidateCurrentReport: boolean;
  };
};

export function DailyCategoryManager({
  open,
  onClose,
  returnFocusRef,
  onCategoryDeactivated
}: DailyCategoryManagerProps) {
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["coupang-daily-report-category-catalog"],
    queryFn: () => apiGet<CoupangDailyReportCategoryCatalogResponse>(
      "/coupang/daily-report/category-catalog?includeInactive=true"
    ),
    enabled: open
  });
  const [draftBase, setDraftBase] = useState<CoupangDailyReportCategory | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState(100);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const wasOpenRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const selectCategory = (category: CoupangDailyReportCategory | null) => {
    setDraftBase(category);
    setName(category?.displayName ?? "");
    setSortOrder(category?.sortOrder ?? 100);
    setSelected(new Set(category?.productIds ?? []));
    setSuccessMessage(null);
    save.reset();
    deactivate.reset();
  };

  useEffect(() => {
    if (!open) {
      initializedRef.current = false;
      return;
    }
    if (!catalog.data || initializedRef.current) return;
    initializedRef.current = true;
    selectCategory(catalog.data.categories[0] ?? null);
  }, [open, catalog.data]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const frame = window.requestAnimationFrame(() => (
        nameInputRef.current ?? closeButtonRef.current
      )?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      returnFocusRef.current?.focus();
    }
  }, [open, returnFocusRef, catalog.isLoading]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const invalidateCategoryData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["coupang-daily-report-categories"] }),
      queryClient.invalidateQueries({ queryKey: ["coupang-daily-report-category-catalog"] })
    ]);
  };

  const invalidateReport = () => (
    queryClient.invalidateQueries({ queryKey: ["coupang-daily-report"] })
  );

  const invalidate = async () => {
    await Promise.all([invalidateCategoryData(), invalidateReport()]);
  };

  const save = useMutation({
    onMutate: () => setSuccessMessage(null),
    mutationFn: async () => {
      if (!draftBase) {
        return apiPost<CoupangDailyReportCategory>("/coupang/daily-report/categories", {
          displayName: name.trim(),
          sortOrder,
          productIds: [...selected]
        });
      }
      return apiPut<CoupangDailyReportCategory>(
        `/coupang/daily-report/categories/${draftBase.id}/products`,
        {
          displayName: name.trim(),
          sortOrder,
          productIds: [...selected],
          expectedUpdatedAt: draftBase.updatedAt
        }
      );
    },
    onSuccess: async (updated) => {
      const message = draftBase
        ? "카테고리 변경사항을 저장했습니다."
        : "새 카테고리를 만들었습니다.";
      selectCategory(updated);
      setSuccessMessage(message);
      await invalidate();
    }
  });

  const deactivate = useMutation({
    onMutate: () => setSuccessMessage(null),
    mutationFn: () => {
      if (!draftBase) throw new Error("선택한 카테고리가 없습니다.");
      return draftBase.isActive
        ? apiDelete<CoupangDailyReportCategory>(
          `/coupang/daily-report/categories/${draftBase.id}`
        )
        : apiPatch<CoupangDailyReportCategory>(
          `/coupang/daily-report/categories/${draftBase.id}`,
          { isActive: true }
        );
    },
    onSuccess: async (updated) => {
      const wasDeactivated = Boolean(draftBase?.isActive && !updated.isActive);
      const message = draftBase?.isActive
        ? "카테고리를 비활성화했습니다."
        : "카테고리를 다시 활성화했습니다.";
      selectCategory(updated);
      setSuccessMessage(message);
      if (wasDeactivated) {
        const plan = onCategoryDeactivated(updated.id);
        await invalidateCategoryData();
        if (plan.invalidateCurrentReport) await invalidateReport();
        return;
      }
      await invalidate();
    }
  });

  const products = useMemo(() => (catalog.data?.products ?? []).filter((product) => (
    (includeInactive || product.isActive)
    && `${product.productGroup?.displayName ?? ""} ${product.displayName}`
      .toLocaleLowerCase("ko-KR")
      .includes(search.trim().toLocaleLowerCase("ko-KR"))
  )), [catalog.data?.products, includeInactive, search]);

  const productGroups = useMemo(() => {
    const groups = new Map<string, {
      label: string;
      products: CoupangDailyReportCategoryProductOption[];
    }>();
    for (const product of products) {
      const key = product.productGroup?.id ?? "single";
      const entry = groups.get(key) ?? {
        label: product.productGroup?.displayName ?? "단일 제품",
        products: []
      };
      entry.products.push(product);
      groups.set(key, entry);
    }
    return [...groups.entries()];
  }, [products]);

  const toggleMany = (ids: string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) checked ? next.add(id) : next.delete(id);
      return next;
    });
  };

  const toggleActive = () => {
    if (!draftBase) return;
    if (
      draftBase.isActive
      && !window.confirm(
        `"${draftBase.displayName}" 카테고리를 비활성화할까요?\n필터 목록에서는 숨겨지지만 제품 구성은 유지됩니다.`
      )
    ) {
      return;
    }
    deactivate.mutate();
  };

  const loadLatestCategory = async () => {
    const categoryId = draftBase?.id;
    const result = await catalog.refetch();
    if (!result.data || !categoryId) return;
    const latest = result.data.categories.find((category) => category.id === categoryId);
    if (latest) selectCategory(latest);
  };

  if (!open) return null;
  const saveConflict = apiErrorCode(save.error) === "COUPANG_DAILY_CATEGORY_CHANGED";
  const busy = save.isPending || deactivate.isPending;

  return (
    <div
      className="coupang-daily-category-backdrop coupang-daily-no-print"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="coupang-daily-category-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-dialog-title"
        tabIndex={-1}
      >
        <header>
          <h2 id="category-dialog-title">리포트 카테고리 관리</h2>
          <button ref={closeButtonRef} type="button" onClick={onClose}>닫기</button>
        </header>
        {catalog.isLoading ? (
          <p role="status">불러오는 중입니다.</p>
        ) : catalog.isError && !catalog.data ? (
          <div className="coupang-daily-category-state" role="alert">
            <p>카테고리를 불러오지 못했습니다.</p>
            <button type="button" onClick={() => catalog.refetch()}>다시 시도</button>
          </div>
        ) : (
          <div className="coupang-daily-category-manager-grid">
            <nav aria-label="카테고리 목록">
              <button type="button" disabled={busy} onClick={() => selectCategory(null)}>
                + 새 카테고리
              </button>
              {catalog.data?.categories.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  disabled={busy}
                  aria-current={item.id === draftBase?.id ? "page" : undefined}
                  onClick={() => selectCategory(item)}
                >
                  {item.displayName} · 구성원 {item.productIds.length}명
                  {item.isActive ? "" : " (비활성)"}
                </button>
              ))}
            </nav>
            <div className="coupang-daily-category-editor">
              <label>
                카테고리 이름
                <input
                  ref={nameInputRef}
                  value={name}
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                정렬 순서
                <input
                  type="number"
                  value={sortOrder}
                  disabled={busy}
                  onChange={(event) => setSortOrder(Number(event.target.value) || 0)}
                />
              </label>
              <label>
                제품 검색
                <input
                  type="search"
                  value={search}
                  disabled={busy}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={includeInactive}
                  disabled={busy}
                  onChange={(event) => setIncludeInactive(event.target.checked)}
                />
                비활성 제품 포함
              </label>
              <div className="coupang-daily-category-bulk-actions">
                <button
                  type="button"
                  disabled={busy || products.length === 0}
                  onClick={() => toggleMany(products.map((product) => product.id), true)}
                >
                  검색 결과 전체 선택
                </button>
                <button
                  type="button"
                  disabled={busy || products.length === 0}
                  onClick={() => toggleMany(products.map((product) => product.id), false)}
                >
                  검색 결과 전체 해제
                </button>
              </div>
              <div className="coupang-daily-category-products">
                {productGroups.map(([key, group]) => (
                  <CategoryProductGroup
                    key={key}
                    label={group.label}
                    products={group.products}
                    selected={selected}
                    currentCategoryId={draftBase?.id ?? null}
                    categories={catalog.data?.categories ?? []}
                    disabled={busy}
                    onToggleMany={toggleMany}
                  />
                ))}
                {products.length === 0 ? <p>검색 조건에 맞는 제품이 없습니다.</p> : null}
              </div>
              {saveConflict ? (
                <div className="coupang-daily-category-conflict" role="alert">
                  <p>다른 사용자가 이 카테고리를 먼저 변경했습니다. 현재 작성 중인 내용은 자동으로 덮어쓰지 않았습니다.</p>
                  <button
                    type="button"
                    disabled={catalog.isFetching}
                    onClick={loadLatestCategory}
                  >
                    {catalog.isFetching ? "최신 구성 불러오는 중…" : "최신 구성 불러오기"}
                  </button>
                </div>
              ) : save.isError ? (
                <p role="alert">{categoryMutationErrorMessage(save.error, "카테고리를 저장하지 못했습니다.")}</p>
              ) : null}
              {deactivate.isError ? (
                <p role="alert">
                  {categoryMutationErrorMessage(
                    deactivate.error,
                    draftBase?.isActive
                      ? "카테고리를 비활성화하지 못했습니다."
                      : "카테고리를 다시 활성화하지 못했습니다."
                  )}
                </p>
              ) : null}
              {successMessage ? <p role="status">{successMessage}</p> : null}
              <footer>
                {draftBase ? (
                  <button type="button" disabled={busy} onClick={toggleActive}>
                    {deactivate.isPending
                      ? draftBase.isActive ? "비활성화 중…" : "활성화 중…"
                      : draftBase.isActive ? "비활성화" : "다시 활성화"}
                  </button>
                ) : <span />}
                <button
                  type="button"
                  disabled={!name.trim() || busy}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? "저장 중…" : "저장"}
                </button>
              </footer>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function CategoryProductGroup({
  label,
  products,
  selected,
  currentCategoryId,
  categories,
  disabled,
  onToggleMany
}: {
  label: string;
  products: CoupangDailyReportCategoryProductOption[];
  selected: ReadonlySet<string>;
  currentCategoryId: string | null;
  categories: CoupangDailyReportCategory[];
  disabled: boolean;
  onToggleMany: (ids: string[], checked: boolean) => void;
}) {
  const ids = products.map((product) => product.id);
  const state = categoryTreeState(ids, selected);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = state.indeterminate;
  }, [state.indeterminate]);
  return (
    <fieldset disabled={disabled}>
      <legend>
        <label>
          <input
            ref={inputRef}
            type="checkbox"
            checked={state.checked}
            aria-checked={state.indeterminate ? "mixed" : state.checked}
            onChange={(event) => onToggleMany(ids, event.target.checked)}
          />
          {label}
        </label>
      </legend>
      {products.map((product) => {
        const otherNames = categories
          .filter((category) => (
            category.id !== currentCategoryId && product.categoryIds.includes(category.id)
          ))
          .map((category) => category.displayName);
        return (
          <label key={product.id}>
            <input
              type="checkbox"
              checked={selected.has(product.id)}
              onChange={(event) => onToggleMany([product.id], event.target.checked)}
            />
            {product.displayName}{product.isActive ? "" : " (비활성)"}
            {otherNames.length ? <small> · {otherNames.join(" · ")}</small> : null}
          </label>
        );
      })}
    </fieldset>
  );
}

function categoryMutationErrorMessage(error: unknown, fallback: string) {
  switch (apiErrorCode(error)) {
    case "COUPANG_DAILY_CATEGORY_NAME_CONFLICT":
      return "같은 이름의 카테고리가 이미 있습니다.";
    case "COUPANG_DAILY_CATEGORY_NOT_FOUND":
      return "카테고리가 삭제되었거나 더 이상 존재하지 않습니다.";
    default:
      return apiErrorMessage(error, fallback);
  }
}

function getFocusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
  )].filter((element) => element.getAttribute("aria-hidden") !== "true");
}
