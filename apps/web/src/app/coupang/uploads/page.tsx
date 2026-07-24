"use client";

import { Save, Trash2, UploadCloud } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPut,
  uploadCoupangAdsXlsx,
  uploadCoupangMarginCsv,
  uploadCoupangPromotionXlsx,
  uploadCoupangSalesXlsx
} from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { parseSelectedManualPurchaseQuantity, summarizeManualPurchaseDrafts } from "@/lib/coupang-manual-purchase";
import type {
  CoupangManualPurchaseOption,
  CoupangManualPurchaseOptionsResponse,
  CoupangManualPurchaseSaveResponse
} from "@/types/coupang";

type CoupangUploadBatch = {
  id: string;
  sourceType: string;
  originalFilename: string;
  status: string;
  rowCount: number;
  validRowCount: number;
  warningCount: number;
  errorCount: number;
  dataStart?: string | null;
  dataEnd?: string | null;
};

type ManualDraft = {
  quantity: string;
  memo: string;
};

const MANUAL_PURCHASE_VENDOR_FEE_SETTING_KEY = "coupang_manual_purchase_vendor_fee_per_unit_krw";
const KOREAN_PRODUCT_NAME_COLLATOR = new Intl.Collator("ko-KR", {
  numeric: true,
  sensitivity: "base"
});

export default function CoupangUploadsPage() {
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [adsFile, setAdsFile] = useState<File | null>(null);
  const [marginFile, setMarginFile] = useState<File | null>(null);
  const [promotionFile, setPromotionFile] = useState<File | null>(null);
  const [reportDate, setReportDate] = useState(todayInputValue());
  const [effectiveFrom, setEffectiveFrom] = useState(todayInputValue());
  const [manualDate, setManualDate] = useState(todayInputValue());
  const [manualSearch, setManualSearch] = useState("");
  const [manualGroupId, setManualGroupId] = useState("ALL");
  const [activeManualProductId, setActiveManualProductId] = useState<string | null>(null);
  const [manualDrafts, setManualDrafts] = useState<Record<string, ManualDraft>>({});
  const [manualDraftsHydratedDate, setManualDraftsHydratedDate] = useState<string | null>(null);
  const [manualFeeDraft, setManualFeeDraft] = useState("");
  const queryClient = useQueryClient();
  const uploads = useQuery({
    queryKey: ["coupang-uploads"],
    queryFn: () => apiGet<CoupangUploadBatch[]>("/coupang/uploads")
  });
  const manualOptions = useQuery({
    queryKey: ["coupang-manual-purchase-options", manualDate],
    queryFn: () => apiGet<CoupangManualPurchaseOptionsResponse>(`/coupang/manual-purchases/options?date=${encodeURIComponent(manualDate)}`)
  });

  const salesUpload = useMutation({
    mutationFn: () => {
      if (!salesFile) throw new Error("Sales XLSX file is required.");
      return uploadCoupangSalesXlsx(salesFile, { reportDate });
    },
    onSuccess: () => void queryClient.invalidateQueries()
  });
  const adsUpload = useMutation({
    mutationFn: () => {
      if (!adsFile) throw new Error("Ads XLSX file is required.");
      return uploadCoupangAdsXlsx(adsFile);
    },
    onSuccess: () => void queryClient.invalidateQueries()
  });
  const marginUpload = useMutation({
    mutationFn: () => {
      if (!marginFile) throw new Error("Sale price and margin CSV/TSV file is required.");
      return uploadCoupangMarginCsv(marginFile, { effectiveFrom });
    },
    onSuccess: () => void queryClient.invalidateQueries()
  });
  const promotionUpload = useMutation({
    mutationFn: () => {
      if (!promotionFile) throw new Error("Promotion XLSX file is required.");
      return uploadCoupangPromotionXlsx(promotionFile);
    },
    onSuccess: () => void queryClient.invalidateQueries()
  });
  const deleteUpload = useMutation({
    mutationFn: (id: string) => apiDelete(`/coupang/uploads/${id}`),
    onSuccess: () => void queryClient.invalidateQueries()
  });
  const saveManualPurchases = useMutation({
    mutationFn: () => {
      const options = manualOptions.data?.options ?? [];
      const optionById = new Map(options.map((option) => [option.coupangProductId, option]));
      const draftsForSave: Record<string, ManualDraft> = Object.fromEntries(
        options
          .filter((option) => option.existingQuantity > 0 || option.existingMemo)
          .map((option) => [
            option.coupangProductId,
            {
              quantity: option.existingQuantity > 0 ? String(option.existingQuantity) : "",
              memo: option.existingMemo ?? ""
            }
          ])
      );
      Object.assign(draftsForSave, manualDrafts);

      return apiPut<CoupangManualPurchaseSaveResponse>(`/coupang/manual-purchases/${manualDate}`, {
        entries: Object.entries(draftsForSave)
          .map(([coupangProductId, draft]) => {
            const option = optionById.get(coupangProductId);
            const quantity = parseSelectedManualPurchaseQuantity(
              draft.quantity,
              option?.productName ?? coupangProductId,
              draft.memo
            );
            if (quantity === null) return null;
            if (quantity > 0 && !option?.isCalculable) {
              throw new Error(`${option?.productName ?? coupangProductId}: ${option?.warnings[0] ?? "가구매 계산 불가"}`);
            }
            return {
              coupangProductId,
              coupangProductRuleId: option?.coupangProductRuleId ?? null,
              quantity,
              memo: draft.memo
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      });
    },
    onSuccess: (result) => {
      setManualDrafts(
        Object.fromEntries(
          result.rows.map((row) => [
            row.coupangProductId,
            {
              quantity: row.quantity > 0 ? String(row.quantity) : "",
              memo: row.memo ?? ""
            }
          ])
        )
      );
      setManualDraftsHydratedDate(result.date);
      void queryClient.invalidateQueries({ queryKey: ["coupang-manual-purchase-options"] });
      void queryClient.invalidateQueries({ queryKey: ["coupang-product-profit"] });
      void queryClient.invalidateQueries({ queryKey: ["coupang-dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["coupang-daily-report"] });
    }
  });
  const saveManualVendorFee = useMutation({
    mutationFn: () =>
      apiPatch(`/settings/${MANUAL_PURCHASE_VENDOR_FEE_SETTING_KEY}`, {
        valueJson: Number(manualFeeDraft),
        description: "Default vendor fee per Coupang manual purchase unit"
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["coupang-manual-purchase-options"] })
  });

  useEffect(() => {
    const data = manualOptions.data;
    if (!data) return;
    if (data.date !== manualDate || manualDraftsHydratedDate === data.date) return;
    setManualFeeDraft(String(Math.round(data.vendorFeePerUnitKrw)));
    setManualDrafts(
      Object.fromEntries(
        data.options
          .filter((option) => option.existingQuantity > 0 || option.existingMemo)
          .map((option) => [
            option.coupangProductId,
            {
              quantity: option.existingQuantity > 0 ? String(option.existingQuantity) : "",
              memo: option.existingMemo ?? ""
            }
          ])
      )
    );
    setManualDraftsHydratedDate(data.date);
  }, [manualDate, manualDraftsHydratedDate, manualOptions.data]);

  const filteredManualOptions = useMemo(() => {
    const query = manualSearch.trim().toLowerCase();
    return (manualOptions.data?.options ?? [])
      .filter((option) => {
        const matchesGroup = manualGroupId === "ALL" || option.groupId === manualGroupId;
        const searchable = `${option.productName} ${option.ruleDisplayName ?? ""} ${option.searchText}`.toLowerCase();
        return matchesGroup && (!query || searchable.includes(query));
      })
      .sort((left, right) => KOREAN_PRODUCT_NAME_COLLATOR.compare(left.productName, right.productName));
  }, [manualGroupId, manualOptions.data?.options, manualSearch]);

  const manualSummary = useMemo(() => {
    return summarizeManualPurchaseDrafts(manualDrafts, manualOptions.data?.options ?? []);
  }, [manualDrafts, manualOptions.data?.options]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Coupang Uploads</h1>
          <p>Upload sales, ad performance, sale price and margin, and promotion files.</p>
        </div>
      </div>

      <div className="grid two">
        <UploadPanel
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          file={salesFile}
          title="Sales Analysis XLSX"
          isPending={salesUpload.isPending}
          onFile={setSalesFile}
          onUpload={() => salesUpload.mutate()}
        >
          <input className="input" type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
          <MutationMessage mutation={salesUpload} />
        </UploadPanel>
        <UploadPanel
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          file={adsFile}
          title="Ads Performance XLSX"
          isPending={adsUpload.isPending}
          onFile={setAdsFile}
          onUpload={() => adsUpload.mutate()}
        >
          <MutationMessage mutation={adsUpload} />
        </UploadPanel>
      </div>

      <div className="grid two" style={{ marginTop: 12 }}>
        <UploadPanel
          accept=".csv,.tsv,text/csv,text/tab-separated-values"
          file={marginFile}
          title="Sale Price & Product Margin CSV/TSV"
          isPending={marginUpload.isPending}
          onFile={setMarginFile}
          onUpload={() => marginUpload.mutate()}
        >
          <input className="input" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
          <p className="muted">판매수수료율/판매수수료 컬럼은 필수가 아니며, 포함되어도 공통 판매 수수료율 설정으로 대체되어 무시됩니다.</p>
          <MutationMessage mutation={marginUpload} />
        </UploadPanel>
        <UploadPanel
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          file={promotionFile}
          title="Promotion XLSX"
          isPending={promotionUpload.isPending}
          onFile={setPromotionFile}
          onUpload={() => promotionUpload.mutate()}
        >
          <MutationMessage mutation={promotionUpload} />
        </UploadPanel>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="toolbar">
          <h2 style={{ marginRight: "auto" }}>가구매 수동 입력</h2>
          <input
            className="input"
            type="date"
            value={manualDate}
            onChange={(event) => {
              setManualDate(event.target.value);
              setManualDrafts({});
              setManualDraftsHydratedDate(null);
              setActiveManualProductId(null);
            }}
          />
          <select className="input" value={manualGroupId} onChange={(event) => setManualGroupId(event.target.value)}>
            <option value="ALL">전체 그룹</option>
            {(manualOptions.data?.groups ?? []).map((group) => (
              <option key={group.id} value={group.id}>
                {group.displayName}
              </option>
            ))}
          </select>
          <input
            className="input"
            type="search"
            placeholder="상품 검색"
            value={manualSearch}
            onChange={(event) => setManualSearch(event.target.value)}
          />
        </div>

        <div className="manual-purchase-fee">
          <label className="field">
            <span className="field-label">건당 업체 수수료</span>
            <span className="input-with-unit">
              <input
                className="input"
                inputMode="numeric"
                value={manualFeeDraft}
                onChange={(event) => setManualFeeDraft(event.target.value)}
              />
              <span>원</span>
            </span>
          </label>
          <button
            className="button"
            type="button"
            disabled={saveManualVendorFee.isPending || !(Number(manualFeeDraft) > 0)}
            onClick={() => saveManualVendorFee.mutate()}
          >
            <Save size={15} />
            설정 저장
          </button>
          <MutationMessage mutation={saveManualVendorFee} />
        </div>

        <div className="manual-purchase-summary">
          <SummaryMetric label="선택 상품" value={`${manualSummary.selectedOptionCount.toLocaleString("ko-KR")}개`} />
          <SummaryMetric label="총 가구매 수량" value={`${manualSummary.totalQuantity.toLocaleString("ko-KR")}개`} />
          <SummaryMetric label="예상 가구매 매출 조정" value={money(manualSummary.expectedSalesAmountKrw)} />
          <SummaryMetric label="예상 업체수수료" value={money(manualSummary.expectedVendorFeeKrw)} />
        </div>

        {manualSummary.uncalculableCount > 0 ? (
          <div className="warning-strip">
            계산 불가 선택 상품 {manualSummary.uncalculableCount.toLocaleString("ko-KR")}개 — {manualSummary.uncalculableReasons.join(", ")}
          </div>
        ) : null}

        <div className="warning-strip manual-purchase-notice">
          <span>가구매 매출은 해당 날짜 상품의 프로모션 없는 기본판매가 × 수량으로 원본 실적에서 차감합니다.</span>
          <span>가구매 비용은 실제 업체수수료만 최종 순이익에서 차감합니다. 상품원가·쿠팡수수료·배송비·기타 부가 비용은 추가 차감하지 않습니다.</span>
        </div>

        {manualOptions.isError ? <p className="muted">{manualOptions.error.message}</p> : null}
        <div className="manual-purchase-grid">
          {filteredManualOptions.map((option) => {
            const draft = manualDrafts[option.coupangProductId] ?? emptyManualDraft(option);
            const quantity = Number(draft.quantity);
            const selected = Number.isFinite(quantity) && quantity > 0;
            const hasMemo = draft.memo.trim().length > 0;
            const expanded = activeManualProductId === option.coupangProductId;
            const canEditQuantity = option.isCalculable || option.existingQuantity > 0;
            const controlsId = `manual-purchase-controls-${option.coupangProductId}`;
            return (
              <div
                key={option.coupangProductId}
                className={`manual-purchase-card${selected || hasMemo ? " active" : ""}${expanded ? " expanded" : ""}${!canEditQuantity ? " disabled" : ""}`}
              >
                <button
                  type="button"
                  className="manual-purchase-card-main"
                  aria-controls={controlsId}
                  aria-expanded={expanded}
                  aria-label={`${option.productName} 가구매 입력 ${expanded ? "접기" : "열기"}`}
                  title={option.productName}
                  onClick={() =>
                    setActiveManualProductId((current) =>
                      current === option.coupangProductId ? null : option.coupangProductId
                    )
                  }
                >
                  <strong>{option.productName}</strong>
                </button>
                {expanded ? (
                  <div className="manual-purchase-controls" id={controlsId}>
                    {option.warnings.length > 0 ? <p className="manual-purchase-warning">{option.warnings[0]}</p> : null}
                    <input
                      className="input"
                      inputMode="numeric"
                      placeholder="가구매 수량"
                      aria-label={`${option.productName} 가구매 수량`}
                      autoFocus={canEditQuantity}
                      value={draft.quantity}
                      disabled={!canEditQuantity}
                      onChange={(event) =>
                        setManualDrafts((current) => ({
                          ...current,
                          [option.coupangProductId]: {
                            quantity: event.target.value,
                            memo: current[option.coupangProductId]?.memo ?? option.existingMemo ?? ""
                          }
                        }))
                      }
                    />
                    <input
                      className="input"
                      placeholder="기타사항"
                      aria-label={`${option.productName} 기타사항`}
                      autoFocus={!canEditQuantity}
                      value={draft.memo}
                      onChange={(event) =>
                        setManualDrafts((current) => ({
                          ...current,
                          [option.coupangProductId]: {
                            quantity: current[option.coupangProductId]?.quantity ?? draft.quantity,
                            memo: event.target.value
                          }
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="toolbar" style={{ marginTop: 12 }}>
          <button
            className="button primary"
            type="button"
            disabled={saveManualPurchases.isPending || manualOptions.isLoading}
            onClick={() => saveManualPurchases.mutate()}
          >
            <Save size={16} />
            저장
          </button>
          <MutationMessage mutation={saveManualPurchases} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>Coupang Batch History</h2>
        <DataTable
          rows={uploads.data ?? []}
          columns={[
            { key: "file", header: "File", render: (row) => row.originalFilename },
            { key: "source", header: "Source", render: (row) => row.sourceType },
            { key: "status", header: "Status", render: (row) => row.status },
            { key: "period", header: "Period", render: (row) => `${formatDate(row.dataStart)} ~ ${formatDate(row.dataEnd)}` },
            { key: "rows", header: "Rows", render: (row) => row.rowCount },
            { key: "valid", header: "Valid", render: (row) => row.validRowCount },
            { key: "warnings", header: "Warnings", render: (row) => row.warningCount },
            { key: "errors", header: "Errors", render: (row) => row.errorCount },
            {
              key: "actions",
              header: "",
              render: (row) => (
                <button
                  className="icon-button danger"
                  type="button"
                  title="Delete upload"
                  disabled={deleteUpload.isPending}
                  onClick={() => {
                    if (window.confirm(`${row.originalFilename} upload data will be deleted.`)) {
                      deleteUpload.mutate(row.id);
                    }
                  }}
                >
                  <Trash2 size={15} />
                </button>
              )
            }
          ]}
        />
      </div>
    </section>
  );
}

function UploadPanel({
  accept,
  children,
  file,
  isPending,
  onFile,
  onUpload,
  title
}: {
  accept: string;
  children?: ReactNode;
  file: File | null;
  isPending: boolean;
  onFile: (file: File | null) => void;
  onUpload: () => void;
  title: string;
}) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <div className="dropzone">
        <input className="input" type="file" accept={accept} onChange={(event) => onFile(event.target.files?.[0] ?? null)} />
        {children}
        <button className="button primary" type="button" disabled={!file || isPending} onClick={onUpload}>
          <UploadCloud size={16} />
          Upload
        </button>
      </div>
    </div>
  );
}

function MutationMessage({ mutation }: { mutation: { data: unknown; error: Error | null; isError: boolean } }) {
  if (mutation.isError) {
    return <span style={{ color: "#b42318" }}>{mutation.error?.message}</span>;
  }
  return mutation.data ? <pre>{JSON.stringify(mutation.data, null, 2)}</pre> : null;
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="manual-purchase-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function emptyManualDraft(option: CoupangManualPurchaseOption): ManualDraft {
  return {
    quantity: "",
    memo: option.existingMemo ?? ""
  };
}

function todayInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function formatDate(value?: string | null) {
  return value ? value.slice(0, 10) : "-";
}

function money(value: number | null | undefined) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${Math.round(value).toLocaleString("ko-KR")}원`;
}
