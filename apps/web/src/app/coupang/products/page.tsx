"use client";

import { ChevronDown, ChevronRight, Pencil, Save, Trash2, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { buildCoupangCostPayload, validateCoupangCostForm, type CoupangCostField } from "@/lib/coupang-cost-form";
import { koreaTodayDateInput, previewCoupangCostHistory } from "@/lib/coupang-cost-history-ui";
import { coupangProductIdFromSearch } from "@/lib/coupang-product-settings-link";
import { percentInputToRate, rateToPercentInput } from "@/lib/percent-input";
import {
  canSaveCoupangProductForm,
  COUPANG_SALES_FEE_DEPENDENT_QUERY_KEYS,
  coupangCostCorrectionSuccessLabel,
  coupangMoneyLabel,
  coupangProductCreationSuccessLabel,
  coupangRateLabel,
  currentCoupangSalesFeeLabel
} from "@/lib/coupang-sales-fee-ui";
import { DataTable } from "@/components/data-table";

type CoupangProductGroup = {
  id: string;
  standardName: string;
  displayName: string;
  sortOrder: number;
  isActive: boolean;
  products?: Array<{ id: string }>;
};

type CoupangProductRule = {
  id: string;
  displayName: string;
  includeKeywords: unknown;
  excludeKeywords: unknown;
  priority: number;
  saleMethod?: string | null;
  adEnabled: boolean;
  isActive: boolean;
  validFrom?: string;
  validTo?: string | null;
};

type CoupangCostRule = {
  id: string;
  salePriceKrw?: string | number | null;
  supplyPriceKrw?: string | number | null;
  productCostKrw?: string | number | null;
  salesFeeRate?: string | number | null;
  salesFeeKrw?: string | number | null;
  sellerShippingFeeKrw?: string | number | null;
  hanaroShippingFeeKrw?: string | number | null;
  growthInboundFeeKrw?: string | number | null;
  growthShippingFeeKrw?: string | number | null;
  returnRate?: string | number | null;
  returnCostPerUnitKrw?: string | number | null;
  extraCostKrw?: string | number | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  createdAt?: string;
  note?: string | null;
};

type CoupangSalesFeeRule = {
  id: string;
  salesFeeRate: number;
  salesFeePercent: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  createdAt: string;
};

type CoupangProductSetting = {
  id: string;
  groupId: string | null;
  standardName: string;
  displayName: string;
  sortOrder: number;
  isActive: boolean;
  group?: CoupangProductGroup | null;
  productRules: CoupangProductRule[];
  costRules: CoupangCostRule[];
  currentCostRule: CoupangCostRule | null;
};

type CoupangProductConfigurationSaveResponse = {
  product: CoupangProductSetting;
  costRuleChange: null | {
    operation: "CREATED" | "UPDATED_SAME_DATE";
    rule: CoupangCostRule;
    effectiveFrom: string;
    effectiveTo: string | null;
    nextRuleEffectiveFrom: string | null;
  };
};

type CoupangProductSaveResult =
  | { kind: "CORRECTION"; rule: CoupangCostRule }
  | { kind: "CONFIGURATION"; response: CoupangProductConfigurationSaveResponse }
  | { kind: "CREATION"; product: CoupangProductSetting };

type ProductForm = {
  displayName: string;
  groupId: string;
  salePriceKrw: string;
  supplyPriceKrw: string;
  productCostKrw: string;
  legacySalesFeePercent: string;
  sellerShippingFeeKrw: string;
  hanaroShippingFeeKrw: string;
  growthInboundFeeKrw: string;
  growthShippingFeeKrw: string;
  returnRate: string;
  returnCostPerUnitKrw: string;
  extraCostKrw: string;
  effectiveFrom: string;
  includeKeywords: string;
  excludeKeywords: string;
  priority: string;
  mappingRuleId: string;
};

type CostSnapshot = Pick<
  ProductForm,
  | "salePriceKrw"
  | "supplyPriceKrw"
  | "productCostKrw"
  | "legacySalesFeePercent"
  | "sellerShippingFeeKrw"
  | "hanaroShippingFeeKrw"
  | "growthInboundFeeKrw"
  | "growthShippingFeeKrw"
  | "returnRate"
  | "returnCostPerUnitKrw"
  | "extraCostKrw"
  | "effectiveFrom"
>;

export default function CoupangProductsPage() {
  const koreaToday = koreaTodayDateInput();
  const [form, setForm] = useState<ProductForm>(() => createInitialForm());
  const [groupName, setGroupName] = useState("");
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editingProductName, setEditingProductName] = useState("");
  const [correctingCostRuleId, setCorrectingCostRuleId] = useState<string | null>(null);
  const [costCorrectionMessage, setCostCorrectionMessage] = useState("");
  const [globalFeePercent, setGlobalFeePercent] = useState("");
  const [globalFeeEffectiveFrom, setGlobalFeeEffectiveFrom] = useState(() => koreaTodayDateInput());
  const [correctingGlobalRuleId, setCorrectingGlobalRuleId] = useState<string | null>(null);
  const [salesFeeSaveMessage, setSalesFeeSaveMessage] = useState("");
  const [isFeeHistoryOpen, setIsFeeHistoryOpen] = useState(false);
  const [originalCost, setOriginalCost] = useState<CostSnapshot | null>(null);
  const [mappingNotice, setMappingNotice] = useState(false);
  const [isGroupsOpen, setIsGroupsOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const openedLinkedProductId = useRef<string | null>(null);
  const queryClient = useQueryClient();

  const products = useQuery({
    queryKey: ["coupang-product-settings"],
    queryFn: () => apiGet<CoupangProductSetting[]>("/coupang/product-settings")
  });
  const groups = useQuery({
    queryKey: ["coupang-product-groups"],
    queryFn: () => apiGet<CoupangProductGroup[]>("/coupang/product-groups")
  });
  const salesFeeRules = useQuery({
    queryKey: ["coupang-sales-fee-rules"],
    queryFn: () => apiGet<CoupangSalesFeeRule[]>("/coupang/sales-fee-rules")
  });
  const currentGlobalFeeRule = currentSalesFeeRule(salesFeeRules.data ?? [], koreaToday);
  const costValidation = useMemo(
    () => validateCoupangCostForm(form, Boolean(correctingCostRuleId)),
    [correctingCostRuleId, form]
  );
  const costDirty = useMemo(
    () => !originalCost || !sameCostSnapshot(costSnapshotFromForm(form), originalCost),
    [form, originalCost]
  );

  useEffect(() => {
    if (globalFeePercent || correctingGlobalRuleId) return;
    if (currentGlobalFeeRule) setGlobalFeePercent(rateToPercentInput(currentGlobalFeeRule.salesFeeRate));
  }, [correctingGlobalRuleId, currentGlobalFeeRule, globalFeePercent]);

  const saveSalesFeeRule = useMutation({
    mutationFn: () => {
      const rate = percentInputToRate(globalFeePercent);
      if (rate === undefined) throw new Error("판매 수수료율을 입력하세요.");
      const payload = { salesFeePercent: rate * 100, effectiveFrom: globalFeeEffectiveFrom };
      return correctingGlobalRuleId
        ? apiPatch<{ rule: CoupangSalesFeeRule }>(`/coupang/sales-fee-rules/${correctingGlobalRuleId}`, payload)
        : apiPost<{ rule: CoupangSalesFeeRule }>("/coupang/sales-fee-rules", payload);
    },
    onMutate: () => setSalesFeeSaveMessage(""),
    onSuccess: async (result: { rule?: CoupangSalesFeeRule }) => {
      setCorrectingGlobalRuleId(null);
      await queryClient.invalidateQueries({ queryKey: ["coupang-sales-fee-rules"] });
      for (const queryKey of COUPANG_SALES_FEE_DEPENDENT_QUERY_KEYS) {
        await queryClient.invalidateQueries({ queryKey: [queryKey] });
      }
      setGlobalFeePercent("");
      setGlobalFeeEffectiveFrom(koreaTodayDateInput());
      setSalesFeeSaveMessage(result.rule
        ? `저장 완료: ${result.rule.salesFeePercent}% (${result.rule.effectiveFrom}부터 적용)`
        : "공통 판매 수수료율을 저장했습니다.");
    }
  });

  const save = useMutation<CoupangProductSaveResult, Error, void>({
    mutationFn: async (): Promise<CoupangProductSaveResult> => {
      if (editingProductId && correctingCostRuleId) {
        const rule = await apiPatch<CoupangCostRule>(
          `/coupang/product-settings/${editingProductId}/cost-rules/${correctingCostRuleId}`,
          buildCoupangCostPayload(form, { includeLegacySalesFee: true })
        );
        return { kind: "CORRECTION", rule };
      }
      if (editingProductId) {
        const response = await apiPatch<CoupangProductConfigurationSaveResponse>(
          `/coupang/product-settings/${editingProductId}/configuration`,
          buildUpdatePayload(form, costDirty)
        );
        return { kind: "CONFIGURATION", response };
      }
      const product = await apiPost<CoupangProductSetting>("/coupang/product-settings", buildCreatePayload(form));
      return { kind: "CREATION", product };
    },
    onMutate: () => setCostCorrectionMessage(""),
    onSuccess: async (result) => {
      const changedCost = result.kind !== "CONFIGURATION" || Boolean(result.response.costRuleChange);
      await queryClient.invalidateQueries({ queryKey: ["coupang-product-settings"] });
      if (changedCost) {
        for (const queryKey of COUPANG_SALES_FEE_DEPENDENT_QUERY_KEYS) {
          await queryClient.invalidateQueries({ queryKey: [queryKey] });
        }
      }
      resetForm();
      setMappingNotice(result.kind === "CONFIGURATION");
      if (result.kind === "CORRECTION") {
        setCostCorrectionMessage(coupangCostCorrectionSuccessLabel(result.rule, koreaTodayDateInput()));
      } else if (result.kind === "CONFIGURATION") {
        setCostCorrectionMessage(configurationSaveSuccessLabel(result.response, koreaTodayDateInput()));
      } else {
        setCostCorrectionMessage(coupangProductCreationSuccessLabel(result.product, koreaTodayDateInput()));
      }
    }
  });
  const createGroup = useMutation({
    mutationFn: () => apiPost("/coupang/product-groups", { displayName: groupName, standardName: groupName }),
    onSuccess: () => {
      setGroupName("");
      void queryClient.invalidateQueries({ queryKey: ["coupang-product-groups"] });
    }
  });
  const deactivateGroup = useMutation({
    mutationFn: (id: string) => apiDelete(`/coupang/product-groups/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["coupang-product-groups"] });
      void queryClient.invalidateQueries({ queryKey: ["coupang-product-settings"] });
    }
  });

  const editingProduct = products.data?.find((product) => product.id === editingProductId) ?? null;
  const costHistoryPreview = editingProduct && /^\d{4}-\d{2}-\d{2}$/.test(form.effectiveFrom)
    ? previewCoupangCostHistory(editingProduct.costRules, form.effectiveFrom, koreaToday, correctingCostRuleId)
    : null;
  const correctionDateCollision = Boolean(correctingCostRuleId && costHistoryPreview?.dateCollisionRule);
  const canSave = canSaveCoupangProductForm({
    displayName: form.displayName,
    isEditing: Boolean(editingProductId),
    isCorrectingCostRule: Boolean(correctingCostRuleId),
    includeKeywordCount: listValue(form.includeKeywords).length
  }) && costValidation.isValid && !correctionDateCollision;

  function resetForm() {
    const nextForm = createInitialForm();
    setForm(nextForm);
    setEditingProductId(null);
    setEditingProductName("");
    setCorrectingCostRuleId(null);
    setCostCorrectionMessage("");
    setOriginalCost(costSnapshotFromForm(nextForm));
  }

  const editProduct = useCallback((row: CoupangProductSetting) => {
    const latestCost = row.currentCostRule;
    const primaryRule = row.productRules.find((rule) => rule.isActive !== false) ?? row.productRules[0];
    const nextForm: ProductForm = {
      displayName: inputText(row.displayName),
      groupId: inputText(row.groupId),
      salePriceKrw: numberInput(latestCost?.salePriceKrw),
      supplyPriceKrw: numberInput(latestCost?.supplyPriceKrw),
      productCostKrw: numberInput(latestCost?.productCostKrw),
      legacySalesFeePercent: rateToPercentInput(latestCost?.salesFeeRate),
      sellerShippingFeeKrw: numberInput(latestCost?.sellerShippingFeeKrw),
      hanaroShippingFeeKrw: numberInput(latestCost?.hanaroShippingFeeKrw),
      growthInboundFeeKrw: numberInput(latestCost?.growthInboundFeeKrw),
      growthShippingFeeKrw: numberInput(latestCost?.growthShippingFeeKrw),
      returnRate: rateToPercentInput(latestCost?.returnRate),
      returnCostPerUnitKrw: numberInput(latestCost?.returnCostPerUnitKrw),
      extraCostKrw: numberInput(latestCost?.extraCostKrw),
      effectiveFrom: koreaTodayDateInput(),
      includeKeywords: listText(primaryRule?.includeKeywords),
      excludeKeywords: listText(primaryRule?.excludeKeywords),
      priority: inputText(primaryRule?.priority ?? 100),
      mappingRuleId: inputText(primaryRule?.id)
    };
    setForm(nextForm);
    setEditingProductId(row.id);
    setEditingProductName(row.displayName);
    setCorrectingCostRuleId(null);
    setOriginalCost(costSnapshotFromForm(nextForm));
    setMappingNotice(false);
    setCostCorrectionMessage("");
  }, []);

  function correctCostRule(rule: CoupangCostRule) {
    if (!editingProductId) return;
    const nextForm = formFromCostRule(form, rule);
    setForm(nextForm);
    setCorrectingCostRuleId(rule.id);
    setOriginalCost(costSnapshotFromForm(nextForm));
    setCostCorrectionMessage("");
  }

  function correctGlobalRule(rule: CoupangSalesFeeRule) {
    setCorrectingGlobalRuleId(rule.id);
    setGlobalFeePercent(rateToPercentInput(rule.salesFeeRate));
    setGlobalFeeEffectiveFrom(rule.effectiveFrom);
  }

  useEffect(() => {
    const requestedProductId = coupangProductIdFromSearch(window.location.search);
    if (!requestedProductId || openedLinkedProductId.current === requestedProductId) return;
    const requestedProduct = products.data?.find((product) => product.id === requestedProductId);
    if (!requestedProduct) return;
    openedLinkedProductId.current = requestedProductId;
    editProduct(requestedProduct);
  }, [editProduct, products.data]);

  function setFormValue(key: keyof ProductForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function setCostValue(key: keyof CostSnapshot, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>쿠팡 상품 설정</h1>
          <p>쿠팡 상품 매칭과 판매가, 원가, 비용 기준을 관리합니다.</p>
        </div>
      </div>

      {mappingNotice ? (
        <div className="warning-strip">
          <span>저장됐습니다. 매칭 규칙을 바꾼 경우 기존 업로드 데이터에는 재매칭 실행 후 반영됩니다.</span>
        </div>
      ) : null}

      {costCorrectionMessage ? (
        <div className="warning-strip">
          <span>{costCorrectionMessage}</span>
        </div>
      ) : null}

      <div className="panel">
        <div className="toolbar" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2>쿠팡 공통 판매 수수료율</h2>
            <p className="muted">이 값은 모든 쿠팡 상품의 판매 수수료 계산에 공통 적용됩니다.</p>
            <p className="muted">
              현재 적용: {currentCoupangSalesFeeLabel(currentGlobalFeeRule)}
            </p>
          </div>
          <button className="button" type="button" onClick={() => setIsFeeHistoryOpen((open) => !open)}>
            {isFeeHistoryOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            최근 변경 이력
          </button>
        </div>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label className="field">
            <span className="field-label">판매 수수료율 (%)</span>
            <input
              className="input"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={globalFeePercent}
              onChange={(event) => setGlobalFeePercent(event.target.value)}
            />
            <span className="muted">예: 11.88 입력 → 11.88% 적용</span>
          </label>
          <label className="field">
            <span className="field-label">적용 시작일</span>
            <input className="input" type="date" value={globalFeeEffectiveFrom} onChange={(event) => setGlobalFeeEffectiveFrom(event.target.value)} />
            <span className="muted">과거 날짜는 해당 기간의 보고서와 가구매 스냅샷을 재계산합니다.</span>
          </label>
          <div className="form-actions" style={{ alignItems: "end" }}>
            {correctingGlobalRuleId ? (
              <button
                className="button"
                type="button"
                onClick={() => {
                  setCorrectingGlobalRuleId(null);
                  setGlobalFeePercent(currentGlobalFeeRule ? rateToPercentInput(currentGlobalFeeRule.salesFeeRate) : "");
                  setGlobalFeeEffectiveFrom(koreaTodayDateInput());
                }}
              >
                <X size={16} /> 정정 취소
              </button>
            ) : null}
            <button className="button primary" type="button" disabled={saveSalesFeeRule.isPending} onClick={() => saveSalesFeeRule.mutate()}>
              <Save size={16} /> {correctingGlobalRuleId ? "선택 이력 정정" : "새 적용값 저장"}
            </button>
          </div>
          {saveSalesFeeRule.isError ? <span style={{ color: "#b42318" }}>{saveSalesFeeRule.error.message}</span> : null}
          {salesFeeSaveMessage ? <span style={{ color: "#067647" }}>{salesFeeSaveMessage}</span> : null}
        </div>
        {isFeeHistoryOpen ? (
          <div style={{ marginTop: 12 }}>
            <DataTable
              rows={salesFeeRules.data ?? []}
              empty="등록된 공통 판매 수수료율이 없습니다."
              columns={[
                { key: "from", header: "적용 시작일", render: (row) => row.effectiveFrom },
                { key: "to", header: "적용 종료일", render: (row) => row.effectiveTo ?? "현재" },
                { key: "rate", header: "판매 수수료율", render: (row) => `${row.salesFeePercent}%` },
                { key: "created", header: "생성 시각", render: (row) => formatDateTime(row.createdAt) },
                {
                  key: "correct",
                  header: "관리",
                  render: (row) => <button className="button" type="button" onClick={() => correctGlobalRule(row)}>이 이력 정정</button>
                }
              ]}
            />
          </div>
        ) : null}
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>{correctingCostRuleId ? "과거 비용 이력 정정" : editingProductId ? "쿠팡 상품 수정" : "새 쿠팡 상품"}</h2>
            {editingProductId ? <p className="muted">{editingProductName}</p> : null}
            {!editingProductId ? <p className="muted">빈 일반 비용은 0원으로 저장됩니다. 배송비 빈칸은 미설정(NULL)입니다.</p> : null}
            {editingProductId && !correctingCostRuleId ? <p className="muted">일반 비용 빈칸은 기존값을 유지합니다. 0원으로 바꾸려면 0을 입력하세요.</p> : null}
          </div>
          <div className="form-actions">
            {editingProductId ? (
              <button className="button" type="button" onClick={resetForm}>
                <X size={16} />
                취소
              </button>
            ) : null}
            <button className="button primary" type="button" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
              <Save size={16} />
              {correctingCostRuleId ? "선택 이력 정정" : editingProductId ? "새 적용값 저장" : "상품 생성"}
            </button>
          </div>
        </div>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">상품명</span>
            <input className="input" value={form.displayName} onChange={(event) => setFormValue("displayName", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">제품그룹</span>
            <select className="input" value={form.groupId} onChange={(event) => setFormValue("groupId", event.target.value)}>
              <option value="">제품그룹 없음</option>
              {(groups.data ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">판매가</span>
            <input className="input" type="text" inputMode="numeric" value={form.salePriceKrw} onChange={(event) => setCostValue("salePriceKrw", event.target.value)} />
            <CostFieldError errors={costValidation.errors} field="salePriceKrw" />
          </label>
          <label className="field">
            <span className="field-label">공급가</span>
            <input className="input" type="text" inputMode="numeric" value={form.supplyPriceKrw} onChange={(event) => setCostValue("supplyPriceKrw", event.target.value)} />
            <span className="muted">참고용입니다. 현재 순이익 계산에는 상품 원가가 사용됩니다.</span>
            <CostFieldError errors={costValidation.errors} field="supplyPriceKrw" />
          </label>
          <label className="field">
            <span className="field-label">상품 원가</span>
            <input className="input" type="text" inputMode="numeric" value={form.productCostKrw} onChange={(event) => setCostValue("productCostKrw", event.target.value)} />
            <CostFieldError errors={costValidation.errors} field="productCostKrw" />
          </label>
          {correctingCostRuleId ? (
            <label className="field">
              <span className="field-label">레거시 상품별 판매 수수료율 정정 (%)</span>
              <input className="input" type="number" min="0" max="100" step="0.01" value={form.legacySalesFeePercent} onChange={(event) => setCostValue("legacySalesFeePercent", event.target.value)} />
              <span className="muted">과거 오입력 기록 정정 전용입니다. 실제 계산은 위 공통 수수료율을 사용합니다.</span>
              <CostFieldError errors={costValidation.errors} field="legacySalesFeePercent" />
            </label>
          ) : null}
          <label className="field">
            <span className="field-label">판매자 배송비 설정(개당)</span>
            <input
              className="input"
              type="text"
              inputMode="numeric"
              value={form.sellerShippingFeeKrw}
              onChange={(event) => setCostValue("sellerShippingFeeKrw", event.target.value)}
            />
            <span className="muted">하나로 창고에서 구매자에게 직접 보내는 택배 비용입니다.</span>
            {!form.sellerShippingFeeKrw.trim() ? <span style={{ color: "#b54708" }}>비우면 미설정(NULL)으로 저장되며 판매 실적 계산이 INCOMPLETE가 될 수 있습니다.</span> : null}
            <CostFieldError errors={costValidation.errors} field="sellerShippingFeeKrw" />
          </label>
          <label className="field">
            <span className="field-label">하나로 배송비 (개당)</span>
            <input
              className="input"
              type="text"
              inputMode="numeric"
              value={form.hanaroShippingFeeKrw}
              onChange={(event) => setCostValue("hanaroShippingFeeKrw", event.target.value)}
            />
            <span className="muted">하나로 창고에서 쿠팡 창고로 옮기는 비용입니다.</span>
            {!form.hanaroShippingFeeKrw.trim() ? <span style={{ color: "#b54708" }}>비우면 미설정(NULL)으로 저장되며 판매 실적 계산이 INCOMPLETE가 될 수 있습니다.</span> : null}
            <CostFieldError errors={costValidation.errors} field="hanaroShippingFeeKrw" />
          </label>
          <label className="field">
            <span className="field-label">그로스 입출고비 (개당)</span>
            <input className="input" type="text" inputMode="numeric" value={form.growthInboundFeeKrw} onChange={(event) => setCostValue("growthInboundFeeKrw", event.target.value)} />
            <span className="muted">쿠팡 창고의 입출고 처리 비용입니다.</span>
            <CostFieldError errors={costValidation.errors} field="growthInboundFeeKrw" />
          </label>
          <label className="field">
            <span className="field-label">그로스 배송비 (개당)</span>
            <input className="input" type="text" inputMode="numeric" value={form.growthShippingFeeKrw} onChange={(event) => setCostValue("growthShippingFeeKrw", event.target.value)} />
            <span className="muted">쿠팡 창고에서 구매자에게 보내는 비용입니다.</span>
            <CostFieldError errors={costValidation.errors} field="growthShippingFeeKrw" />
          </label>
          <label className="field">
            <span className="field-label">반품률 (%)</span>
            <input className="input" type="number" min="0" max="100" step="0.01" value={form.returnRate} onChange={(event) => setCostValue("returnRate", event.target.value)} />
            <CostFieldError errors={costValidation.errors} field="returnRate" />
          </label>
          <label className="field">
            <span className="field-label">반품 1건당 비용</span>
            <input className="input" type="text" inputMode="numeric" value={form.returnCostPerUnitKrw} onChange={(event) => setCostValue("returnCostPerUnitKrw", event.target.value)} />
            <CostFieldError errors={costValidation.errors} field="returnCostPerUnitKrw" />
          </label>
          <label className="field">
            <span className="field-label">기타 비용</span>
            <input className="input" type="text" inputMode="numeric" value={form.extraCostKrw} onChange={(event) => setCostValue("extraCostKrw", event.target.value)} />
            <CostFieldError errors={costValidation.errors} field="extraCostKrw" />
          </label>
          <label className="field">
            <span className="field-label">비용 적용 시작일</span>
            <input className="input" type="date" value={form.effectiveFrom} onChange={(event) => setCostValue("effectiveFrom", event.target.value)} />
            <span className="muted">
              {correctingCostRuleId
                ? "선택 이력의 시작일을 정정합니다."
                : `선택한 날짜부터 새 값을 저장합니다. 한국시간 기준 오늘은 ${koreaToday}입니다.`}
            </span>
            <CostFieldError errors={costValidation.errors} field="effectiveFrom" />
          </label>
          {editingProductId && costHistoryPreview ? (
            <div className="field" style={{ gridColumn: "1 / -1", border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
              <span className="field-label">저장 전 비용 이력 영향</span>
              <span className="muted">현재 적용 이력: {costRuleRangeLabel(costHistoryPreview.currentRule)}</span>
              <span className="muted">
                저장 기준 이력: {costHistoryPreview.basisRule
                  ? costRuleRangeLabel(costHistoryPreview.basisRule)
                  : "없음 (빈 일반 비용은 0원, 배송비는 미설정으로 시작)"}
              </span>
              <span className="muted">
                {correctingCostRuleId ? "다른 동일 날짜 이력" : "동일 날짜 이력"}: {costHistoryPreview.sameDateRule
                  ? correctingCostRuleId
                    ? `${formatDate(costHistoryPreview.sameDateRule.effectiveFrom)} (날짜 충돌: 이 날짜로는 정정할 수 없음)`
                    : `${formatDate(costHistoryPreview.sameDateRule.effectiveFrom)} (새 행 생성 없이 갱신)`
                  : "없음"}
              </span>
              <span className="muted">다음 이력: {costRuleRangeLabel(costHistoryPreview.nextRule)}</span>
              <span className="muted">
                예상 적용 종료일: {correctionDateCollision
                  ? "계산하지 않음 (날짜 충돌을 먼저 해결하세요)"
                  : costHistoryPreview.expectedEffectiveTo ?? "없음 (다음 이력 전까지 계속 적용)"}
              </span>
              <span style={{ color: costHistoryPreview.currentValueImpact === "CURRENT" ? "#067647" : "#b54708" }}>
                오늘 현재값 영향: {costHistoryImpactLabel(costHistoryPreview.currentValueImpact)}
              </span>
            </div>
          ) : null}
          {editingProductId && !correctingCostRuleId ? (
            <>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span className="field-label">매칭 키워드</span>
                <textarea className="textarea" value={form.includeKeywords} onChange={(event) => setFormValue("includeKeywords", event.target.value)} />
              </label>
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span className="field-label">제외 키워드</span>
                <textarea className="textarea" value={form.excludeKeywords} onChange={(event) => setFormValue("excludeKeywords", event.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">우선순위</span>
                <input className="input" value={form.priority} onChange={(event) => setFormValue("priority", event.target.value)} />
              </label>
            </>
          ) : null}
          {save.isError ? <span style={{ color: "#b42318" }}>{save.error.message}</span> : null}
        </div>
        {editingProduct ? (
          <div style={{ marginTop: 16 }}>
            <h3>비용 이력</h3>
            <p className="muted">정정은 선택한 기존 레코드를 직접 수정하므로 과거 보고서 값이 바뀔 수 있습니다.</p>
            <DataTable
              rows={editingProduct.costRules}
              getRowKey={(row) => row.id}
              empty="비용 이력이 없습니다."
              columns={[
                { key: "from", header: "적용 시작일", render: (row) => formatDate(row.effectiveFrom) },
                { key: "to", header: "적용 종료일", render: (row) => formatDate(row.effectiveTo) },
                { key: "current", header: "현재 적용", render: (row) => row.id === editingProduct.currentCostRule?.id ? "적용 중" : "-" },
                { key: "created", header: "생성 시각", render: (row) => formatDateTime(row.createdAt) },
                { key: "price", header: "판매가", render: (row) => money(row.salePriceKrw) },
                { key: "supply", header: "공급가", render: (row) => money(row.supplyPriceKrw) },
                { key: "cost", header: "상품 원가", render: (row) => money(row.productCostKrw) },
                { key: "legacyFee", header: "레거시 수수료율", render: (row) => coupangRateLabel(row.salesFeeRate) },
                { key: "legacyFixedFee", header: "레거시 정액 수수료", render: (row) => money(row.salesFeeKrw) },
                { key: "sellerShip", header: "판매자 배송비", render: (row) => money(row.sellerShippingFeeKrw) },
                { key: "hanaroShip", header: "하나로 배송비", render: (row) => money(row.hanaroShippingFeeKrw) },
                { key: "growthInbound", header: "그로스 입출고비", render: (row) => money(row.growthInboundFeeKrw) },
                { key: "growthShipping", header: "그로스 배송비", render: (row) => money(row.growthShippingFeeKrw) },
                { key: "returnRate", header: "반품률", render: (row) => coupangRateLabel(row.returnRate) },
                { key: "returnCost", header: "반품 1건당 비용", render: (row) => money(row.returnCostPerUnitKrw) },
                { key: "extra", header: "기타 비용", render: (row) => money(row.extraCostKrw) },
                {
                  key: "correct",
                  header: "관리",
                  render: (row) => <button className="button" type="button" onClick={() => correctCostRule(row)}>이 이력 정정</button>
                }
              ]}
            />
          </div>
        ) : null}
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="collapsible-header">
          <button className="collapse-trigger" type="button" aria-expanded={isGroupsOpen} onClick={() => setIsGroupsOpen((open) => !open)}>
            {isGroupsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <h2>제품그룹</h2>
          </button>
          <span className="muted">{(groups.data ?? []).length}개</span>
        </div>
        {isGroupsOpen ? (
          <div className="collapsible-body">
            <div className="toolbar">
              <input className="input" placeholder="그룹명" value={groupName} onChange={(event) => setGroupName(event.target.value)} />
              <button className="button primary" type="button" disabled={!groupName || createGroup.isPending} onClick={() => createGroup.mutate()}>
                <Save size={16} />
                생성
              </button>
              {createGroup.isError ? <span style={{ color: "#b42318" }}>{createGroup.error.message}</span> : null}
            </div>
            <DataTable
              rows={groups.data ?? []}
              empty="등록된 제품그룹이 없습니다."
              columns={[
                { key: "name", header: "제품그룹", render: (row) => row.displayName },
                { key: "products", header: "연결 상품 수", render: (row) => row.products?.length ?? 0 },
                { key: "active", header: "상태", render: (row) => (row.isActive ? "활성" : "비활성") },
                {
                  key: "actions",
                  header: "관리",
                  render: (row) => (
                    <button className="button" type="button" disabled={deactivateGroup.isPending} onClick={() => deactivateGroup.mutate(row.id)}>
                      <Trash2 size={16} />
                      비활성화
                    </button>
                  )
                }
              ]}
            />
          </div>
        ) : null}
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="collapsible-header">
          <button className="collapse-trigger" type="button" aria-expanded={isSettingsOpen} onClick={() => setIsSettingsOpen((open) => !open)}>
            {isSettingsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <h2>설정 목록</h2>
          </button>
          <span className="muted">{(products.data ?? []).length}개</span>
        </div>
        {isSettingsOpen ? (
          <div className="collapsible-body">
            <DataTable
              rows={products.data ?? []}
              empty="등록된 쿠팡 상품이 없습니다."
              onRowClick={editProduct}
              getRowKey={(row) => row.id}
              rowClassName={(row) => (row.id === editingProductId ? "active" : undefined)}
              columns={[
                { key: "name", header: "상품", render: (row) => row.displayName },
                { key: "group", header: "제품그룹", render: (row) => row.group?.displayName ?? "없음" },
                { key: "keywords", header: "매칭 키워드", render: (row) => listText(primaryRule(row)?.includeKeywords) || "-" },
                { key: "excluded", header: "제외 키워드", render: (row) => listText(primaryRule(row)?.excludeKeywords) || "-" },
                { key: "priority", header: "우선순위", render: (row) => primaryRule(row)?.priority ?? "-" },
                { key: "price", header: "판매가", render: (row) => money(row.currentCostRule?.salePriceKrw) },
                { key: "supply", header: "공급가", render: (row) => money(row.currentCostRule?.supplyPriceKrw) },
                { key: "cost", header: "상품 원가", render: (row) => money(row.currentCostRule?.productCostKrw) },
                { key: "sellerShip", header: "판매자 배송비 설정(개당)", render: (row) => money(row.currentCostRule?.sellerShippingFeeKrw) },
                { key: "hanaroShip", header: "하나로 배송비", render: (row) => money(row.currentCostRule?.hanaroShippingFeeKrw) },
                { key: "growthInbound", header: "그로스 입출고비", render: (row) => money(row.currentCostRule?.growthInboundFeeKrw) },
                { key: "growthShip", header: "그로스 배송비", render: (row) => money(row.currentCostRule?.growthShippingFeeKrw) },
                { key: "returnRate", header: "반품률", render: (row) => coupangRateLabel(row.currentCostRule?.returnRate) },
                { key: "return", header: "반품비", render: (row) => money(row.currentCostRule?.returnCostPerUnitKrw) },
                { key: "extra", header: "기타 비용", render: (row) => money(row.currentCostRule?.extraCostKrw) },
                { key: "effective", header: "적용 시작일", render: (row) => formatDate(row.currentCostRule?.effectiveFrom) },
                { key: "active", header: "상태", render: (row) => (row.isActive ? "활성" : "비활성") },
                {
                  key: "edit",
                  header: "수정",
                  render: (row) => (
                    <button
                      className="icon-button"
                      type="button"
                      title="수정"
                      onClick={(event) => {
                        event.stopPropagation();
                        editProduct(row);
                      }}
                    >
                      <Pencil size={16} />
                    </button>
                  )
                }
              ]}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function createInitialForm(): ProductForm {
  return {
    displayName: "",
    groupId: "",
    salePriceKrw: "",
    supplyPriceKrw: "",
    productCostKrw: "",
    legacySalesFeePercent: "",
    sellerShippingFeeKrw: "",
    hanaroShippingFeeKrw: "",
    growthInboundFeeKrw: "",
    growthShippingFeeKrw: "",
    returnRate: "",
    returnCostPerUnitKrw: "",
    extraCostKrw: "",
    effectiveFrom: koreaTodayDateInput(),
    includeKeywords: "",
    excludeKeywords: "",
    priority: "100",
    mappingRuleId: ""
  };
}

function buildCreatePayload(form: ProductForm) {
  return {
    displayName: form.displayName,
    standardName: form.displayName,
    groupId: form.groupId || null,
    ...buildCoupangCostPayload(form)
  };
}

function buildUpdatePayload(form: ProductForm, costDirty: boolean) {
  const payload: Record<string, unknown> = {
    displayName: form.displayName,
    standardName: form.displayName,
    groupId: form.groupId || null,
    mappingRuleId: form.mappingRuleId || undefined,
    includeKeywords: listValue(form.includeKeywords),
    excludeKeywords: listValue(form.excludeKeywords),
    priority: integerValue(form.priority) ?? 100
  };
  if (costDirty) {
    Object.assign(payload, buildCoupangCostPayload(form));
  }
  return payload;
}

function primaryRule(row: CoupangProductSetting) {
  return row.productRules.find((rule) => rule.isActive !== false) ?? row.productRules[0];
}

function formFromCostRule(current: ProductForm, rule: CoupangCostRule): ProductForm {
  return {
    ...current,
    salePriceKrw: numberInput(rule.salePriceKrw),
    supplyPriceKrw: numberInput(rule.supplyPriceKrw),
    productCostKrw: numberInput(rule.productCostKrw),
    legacySalesFeePercent: rateToPercentInput(rule.salesFeeRate),
    sellerShippingFeeKrw: numberInput(rule.sellerShippingFeeKrw),
    hanaroShippingFeeKrw: numberInput(rule.hanaroShippingFeeKrw),
    growthInboundFeeKrw: numberInput(rule.growthInboundFeeKrw),
    growthShippingFeeKrw: numberInput(rule.growthShippingFeeKrw),
    returnRate: rateToPercentInput(rule.returnRate),
    returnCostPerUnitKrw: numberInput(rule.returnCostPerUnitKrw),
    extraCostKrw: numberInput(rule.extraCostKrw),
    effectiveFrom: formatDateInput(rule.effectiveFrom) || koreaTodayDateInput()
  };
}

function currentSalesFeeRule(rules: CoupangSalesFeeRule[], date: string) {
  return rules.find((rule) => rule.effectiveFrom <= date && (!rule.effectiveTo || rule.effectiveTo >= date)) ?? null;
}

function costSnapshotFromForm(form: ProductForm): CostSnapshot {
  return {
    salePriceKrw: form.salePriceKrw.trim(),
    supplyPriceKrw: form.supplyPriceKrw.trim(),
    productCostKrw: form.productCostKrw.trim(),
    legacySalesFeePercent: form.legacySalesFeePercent.trim(),
    sellerShippingFeeKrw: form.sellerShippingFeeKrw.trim(),
    hanaroShippingFeeKrw: form.hanaroShippingFeeKrw.trim(),
    growthInboundFeeKrw: form.growthInboundFeeKrw.trim(),
    growthShippingFeeKrw: form.growthShippingFeeKrw.trim(),
    returnRate: form.returnRate.trim(),
    returnCostPerUnitKrw: form.returnCostPerUnitKrw.trim(),
    extraCostKrw: form.extraCostKrw.trim(),
    effectiveFrom: form.effectiveFrom.trim()
  };
}

function sameCostSnapshot(left: CostSnapshot, right: CostSnapshot) {
  return (Object.keys(left) as Array<keyof CostSnapshot>).every((key) => left[key] === right[key]);
}

function listValue(value: string) {
  return listArray(value);
}

function listArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
  }
  if (typeof value === "string") {
    return Array.from(new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)));
  }
  return [];
}

function listText(value: unknown) {
  return listArray(value).join("\n");
}

function inputText(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function numberInput(value: unknown) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return "";
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : String(value);
}

function integerValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? Math.trunc(parsed) : undefined;
}

function configurationSaveSuccessLabel(result: CoupangProductConfigurationSaveResponse, koreaToday: string) {
  const change = result.costRuleChange;
  if (!change) return "상품 설정을 저장했습니다.";
  const range = change.effectiveTo ? `${change.effectiveFrom}~${change.effectiveTo}` : `${change.effectiveFrom}부터`;
  const operation = change.operation === "CREATED" ? "새 비용 이력 생성" : "동일 날짜 비용 이력 갱신";
  const rule = change.rule;
  const values = [
    `상품원가 ${moneyOrZero(rule.productCostKrw)}`,
    `공급가 ${moneyOrZero(rule.supplyPriceKrw)}`,
    `판매자 배송비 ${nullableMoney(rule.sellerShippingFeeKrw)}`,
    `하나로 배송비 ${nullableMoney(rule.hanaroShippingFeeKrw)}`
  ].join(", ");
  const future = change.effectiveFrom > koreaToday
    ? ` ${change.effectiveFrom}부터 적용될 예정이며 오늘 현재값은 아직 바뀌지 않습니다.`
    : change.nextRuleEffectiveFrom
    ? ` ${change.nextRuleEffectiveFrom}부터 이후 이력이 적용되므로 그 이후 현재값은 바뀌지 않습니다.`
    : " 현재 이후에도 이 값이 적용됩니다.";
  return `비용 저장 완료 (${operation}): ${range}, ${values}.${future}`;
}

function CostFieldError({
  errors,
  field
}: {
  errors: Partial<Record<CoupangCostField, string>>;
  field: CoupangCostField;
}) {
  return errors[field] ? <span style={{ color: "#b42318" }}>{errors[field]}</span> : null;
}

function moneyOrZero(value: string | number | null | undefined) {
  const number = Number(value ?? 0);
  return `${Number.isFinite(number) ? Math.round(number).toLocaleString("ko-KR") : "0"}원`;
}

function nullableMoney(value: string | number | null | undefined) {
  return value === null || value === undefined ? "미설정" : moneyOrZero(value);
}

const money = coupangMoneyLabel;

function costRuleRangeLabel(rule: { effectiveFrom?: string | null; effectiveTo?: string | null } | null) {
  if (!rule?.effectiveFrom) return "없음";
  const from = formatDate(rule.effectiveFrom);
  const to = rule.effectiveTo ? formatDate(rule.effectiveTo) : "현재 이후";
  return `${from}~${to}`;
}

function costHistoryImpactLabel(impact: "CURRENT" | "HISTORICAL" | "FUTURE" | "REJECTED_DATE_COLLISION") {
  if (impact === "REJECTED_DATE_COLLISION") return "다른 이력과 날짜가 겹쳐 저장할 수 없습니다.";
  if (impact === "CURRENT") return "저장 후 오늘의 현재 비용값으로 적용됩니다.";
  if (impact === "FUTURE") return "미래 시작 이력이므로 오늘의 현재 비용값은 바뀌지 않습니다.";
  return "이후 이력이 이미 적용 중이므로 오늘의 현재 비용값은 바뀌지 않습니다.";
}

function formatDate(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "-";
}

function formatDateInput(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}
