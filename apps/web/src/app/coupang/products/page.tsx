"use client";

import { ChevronDown, ChevronRight, Pencil, Save, Trash2, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
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
  salePriceKrw?: string | number | null;
  supplyPriceKrw?: string | number | null;
  productCostKrw?: string | number | null;
  salesFeeRate?: string | number | null;
  salesFeeKrw?: string | number | null;
  sellerShippingFeeKrw?: string | number | null;
  growthInboundFeeKrw?: string | number | null;
  growthShippingFeeKrw?: string | number | null;
  returnRate?: string | number | null;
  returnCostPerUnitKrw?: string | number | null;
  extraCostKrw?: string | number | null;
  effectiveFrom?: string | null;
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
};

type ProductForm = {
  displayName: string;
  groupId: string;
  salePriceKrw: string;
  supplyPriceKrw: string;
  productCostKrw: string;
  salesFeeRate: string;
  salesFeeKrw: string;
  sellerShippingFeeKrw: string;
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
  | "salesFeeRate"
  | "salesFeeKrw"
  | "sellerShippingFeeKrw"
  | "growthInboundFeeKrw"
  | "growthShippingFeeKrw"
  | "returnRate"
  | "returnCostPerUnitKrw"
  | "extraCostKrw"
  | "effectiveFrom"
>;

export default function CoupangProductsPage() {
  const [form, setForm] = useState<ProductForm>(() => createInitialForm());
  const [groupName, setGroupName] = useState("");
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editingProductName, setEditingProductName] = useState("");
  const [originalCost, setOriginalCost] = useState<CostSnapshot | null>(null);
  const [costDirty, setCostDirty] = useState(false);
  const [mappingNotice, setMappingNotice] = useState(false);
  const [isGroupsOpen, setIsGroupsOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const queryClient = useQueryClient();

  const products = useQuery({
    queryKey: ["coupang-product-settings"],
    queryFn: () => apiGet<CoupangProductSetting[]>("/coupang/product-settings")
  });
  const groups = useQuery({
    queryKey: ["coupang-product-groups"],
    queryFn: () => apiGet<CoupangProductGroup[]>("/coupang/product-groups")
  });

  const save = useMutation({
    mutationFn: () => {
      if (editingProductId) {
        return apiPatch(`/coupang/product-settings/${editingProductId}/configuration`, buildUpdatePayload(form, costDirty));
      }
      return apiPost("/coupang/product-settings", buildCreatePayload(form));
    },
    onSuccess: () => {
      const wasEditing = editingProductId !== null;
      resetForm();
      setMappingNotice(wasEditing);
      void queryClient.invalidateQueries();
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

  const canSave = Boolean(form.displayName.trim()) && (!editingProductId || listValue(form.includeKeywords).length > 0);

  function resetForm() {
    const nextForm = createInitialForm();
    setForm(nextForm);
    setEditingProductId(null);
    setEditingProductName("");
    setOriginalCost(costSnapshotFromForm(nextForm));
    setCostDirty(false);
  }

  function editProduct(row: CoupangProductSetting) {
    const latestCost = row.costRules[0];
    const primaryRule = row.productRules.find((rule) => rule.isActive !== false) ?? row.productRules[0];
    const nextForm: ProductForm = {
      displayName: inputText(row.displayName),
      groupId: inputText(row.groupId),
      salePriceKrw: numberInput(latestCost?.salePriceKrw),
      supplyPriceKrw: numberInput(latestCost?.supplyPriceKrw),
      productCostKrw: numberInput(latestCost?.productCostKrw),
      salesFeeRate: numberInput(latestCost?.salesFeeRate),
      salesFeeKrw: numberInput(latestCost?.salesFeeKrw),
      sellerShippingFeeKrw: numberInput(latestCost?.sellerShippingFeeKrw),
      growthInboundFeeKrw: numberInput(latestCost?.growthInboundFeeKrw),
      growthShippingFeeKrw: numberInput(latestCost?.growthShippingFeeKrw),
      returnRate: numberInput(latestCost?.returnRate),
      returnCostPerUnitKrw: numberInput(latestCost?.returnCostPerUnitKrw),
      extraCostKrw: numberInput(latestCost?.extraCostKrw),
      effectiveFrom: todayInput(),
      includeKeywords: listText(primaryRule?.includeKeywords),
      excludeKeywords: listText(primaryRule?.excludeKeywords),
      priority: inputText(primaryRule?.priority ?? 100),
      mappingRuleId: inputText(primaryRule?.id)
    };
    setForm(nextForm);
    setEditingProductId(row.id);
    setEditingProductName(row.displayName);
    setOriginalCost(costSnapshotFromForm(nextForm));
    setCostDirty(false);
    setMappingNotice(false);
  }

  function setFormValue(key: keyof ProductForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function setCostValue(key: keyof CostSnapshot, value: string) {
    const nextForm = { ...form, [key]: value };
    setForm(nextForm);
    setCostDirty(!originalCost || !sameCostSnapshot(costSnapshotFromForm(nextForm), originalCost));
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

      <div className="panel">
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>{editingProductId ? "쿠팡 상품 수정" : "새 쿠팡 상품"}</h2>
            {editingProductId ? <p className="muted">{editingProductName}</p> : null}
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
              저장
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
            <input className="input" value={form.salePriceKrw} onChange={(event) => setCostValue("salePriceKrw", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">공급가</span>
            <input className="input" value={form.supplyPriceKrw} onChange={(event) => setCostValue("supplyPriceKrw", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">상품 원가</span>
            <input className="input" value={form.productCostKrw} onChange={(event) => setCostValue("productCostKrw", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">수수료율</span>
            <input className="input" value={form.salesFeeRate} onChange={(event) => setCostValue("salesFeeRate", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">판매 수수료</span>
            <input className="input" value={form.salesFeeKrw} onChange={(event) => setCostValue("salesFeeKrw", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">판매자 배송비</span>
            <input className="input" value={form.sellerShippingFeeKrw} onChange={(event) => setCostValue("sellerShippingFeeKrw", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">그로스 입출고비</span>
            <input className="input" value={form.growthInboundFeeKrw} onChange={(event) => setCostValue("growthInboundFeeKrw", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">그로스 배송비</span>
            <input className="input" value={form.growthShippingFeeKrw} onChange={(event) => setCostValue("growthShippingFeeKrw", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">반품률</span>
            <input className="input" value={form.returnRate} onChange={(event) => setCostValue("returnRate", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">반품 1건당 비용</span>
            <input className="input" value={form.returnCostPerUnitKrw} onChange={(event) => setCostValue("returnCostPerUnitKrw", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">기타 비용</span>
            <input className="input" value={form.extraCostKrw} onChange={(event) => setCostValue("extraCostKrw", event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">새 비용 기준일</span>
            <input className="input" type="date" value={form.effectiveFrom} onChange={(event) => setCostValue("effectiveFrom", event.target.value)} />
          </label>
          {editingProductId ? (
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
                { key: "price", header: "판매가", render: (row) => money(row.costRules[0]?.salePriceKrw) },
                { key: "supply", header: "공급가", render: (row) => money(row.costRules[0]?.supplyPriceKrw) },
                { key: "cost", header: "상품 원가", render: (row) => money(row.costRules[0]?.productCostKrw) },
                { key: "feeRate", header: "수수료율", render: (row) => rate(row.costRules[0]?.salesFeeRate) },
                { key: "fee", header: "판매 수수료", render: (row) => money(row.costRules[0]?.salesFeeKrw) },
                { key: "sellerShip", header: "판매자 배송비", render: (row) => money(row.costRules[0]?.sellerShippingFeeKrw) },
                { key: "growthInbound", header: "그로스 입출고비", render: (row) => money(row.costRules[0]?.growthInboundFeeKrw) },
                { key: "growthShip", header: "그로스 배송비", render: (row) => money(row.costRules[0]?.growthShippingFeeKrw) },
                { key: "returnRate", header: "반품률", render: (row) => rate(row.costRules[0]?.returnRate) },
                { key: "return", header: "반품비", render: (row) => money(row.costRules[0]?.returnCostPerUnitKrw) },
                { key: "extra", header: "기타 비용", render: (row) => money(row.costRules[0]?.extraCostKrw) },
                { key: "effective", header: "적용 시작일", render: (row) => formatDate(row.costRules[0]?.effectiveFrom) },
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
    salesFeeRate: "",
    salesFeeKrw: "",
    sellerShippingFeeKrw: "",
    growthInboundFeeKrw: "",
    growthShippingFeeKrw: "",
    returnRate: "",
    returnCostPerUnitKrw: "",
    extraCostKrw: "",
    effectiveFrom: todayInput(),
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
    ...costPayload(form)
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
    Object.assign(payload, costPayload(form));
  }
  return payload;
}

function costPayload(form: ProductForm) {
  return {
    salePriceKrw: numberOrUndefined(form.salePriceKrw),
    supplyPriceKrw: numberOrUndefined(form.supplyPriceKrw),
    productCostKrw: numberOrUndefined(form.productCostKrw),
    salesFeeRate: numberOrUndefined(form.salesFeeRate),
    salesFeeKrw: numberOrUndefined(form.salesFeeKrw),
    sellerShippingFeeKrw: numberOrUndefined(form.sellerShippingFeeKrw),
    growthInboundFeeKrw: numberOrUndefined(form.growthInboundFeeKrw),
    growthShippingFeeKrw: numberOrUndefined(form.growthShippingFeeKrw),
    returnRate: numberOrUndefined(form.returnRate),
    returnCostPerUnitKrw: numberOrUndefined(form.returnCostPerUnitKrw),
    extraCostKrw: numberOrUndefined(form.extraCostKrw),
    effectiveFrom: form.effectiveFrom || undefined
  };
}

function primaryRule(row: CoupangProductSetting) {
  return row.productRules.find((rule) => rule.isActive !== false) ?? row.productRules[0];
}

function costSnapshotFromForm(form: ProductForm): CostSnapshot {
  return {
    salePriceKrw: form.salePriceKrw.trim(),
    supplyPriceKrw: form.supplyPriceKrw.trim(),
    productCostKrw: form.productCostKrw.trim(),
    salesFeeRate: form.salesFeeRate.trim(),
    salesFeeKrw: form.salesFeeKrw.trim(),
    sellerShippingFeeKrw: form.sellerShippingFeeKrw.trim(),
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

function numberOrUndefined(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : undefined;
}

function integerValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? Math.trunc(parsed) : undefined;
}

function todayInput() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function money(value: string | number | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number !== 0 ? `${Math.round(number).toLocaleString("ko-KR")}원` : "-";
}

function rate(value: string | number | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number !== 0 ? `${(number * 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%` : "-";
}

function formatDate(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "-";
}
