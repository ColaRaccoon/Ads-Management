"use client";

import { Save, Trash2 } from "lucide-react";
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

type CoupangProductSetting = {
  id: string;
  groupId: string | null;
  standardName: string;
  displayName: string;
  sortOrder: number;
  isActive: boolean;
  group?: CoupangProductGroup | null;
  productRules: Array<{
    displayName: string;
    priority: number;
    saleMethod?: string | null;
    adEnabled: boolean;
  }>;
  costRules: Array<{
    salePriceKrw: string | number;
    supplyPriceKrw: string | number;
    productCostKrw: string | number;
    salesFeeRate: string | number;
    salesFeeKrw: string | number;
    sellerShippingFeeKrw: string | number;
    growthInboundFeeKrw: string | number;
    growthShippingFeeKrw: string | number;
    returnRate: string | number;
    returnCostPerUnitKrw: string | number;
    extraCostKrw: string | number;
    effectiveFrom: string;
  }>;
};

type ProductForm = {
  displayName: string;
  groupId: string;
  salePriceKrw: string;
  productCostKrw: string;
  salesFeeKrw: string;
  sellerShippingFeeKrw: string;
  growthInboundFeeKrw: string;
  growthShippingFeeKrw: string;
  returnRate: string;
  returnCostPerUnitKrw: string;
};

const initialForm: ProductForm = {
  displayName: "",
  groupId: "",
  salePriceKrw: "",
  productCostKrw: "",
  salesFeeKrw: "",
  sellerShippingFeeKrw: "",
  growthInboundFeeKrw: "",
  growthShippingFeeKrw: "",
  returnRate: "",
  returnCostPerUnitKrw: ""
};

export default function CoupangProductsPage() {
  const [form, setForm] = useState<ProductForm>(initialForm);
  const [groupName, setGroupName] = useState("");
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
    mutationFn: () =>
      apiPost("/coupang/product-settings", {
        displayName: form.displayName,
        standardName: form.displayName,
        groupId: form.groupId || null,
        salePriceKrw: numberOrUndefined(form.salePriceKrw),
        productCostKrw: numberOrUndefined(form.productCostKrw),
        salesFeeKrw: numberOrUndefined(form.salesFeeKrw),
        sellerShippingFeeKrw: numberOrUndefined(form.sellerShippingFeeKrw),
        growthInboundFeeKrw: numberOrUndefined(form.growthInboundFeeKrw),
        growthShippingFeeKrw: numberOrUndefined(form.growthShippingFeeKrw),
        returnRate: numberOrUndefined(form.returnRate),
        returnCostPerUnitKrw: numberOrUndefined(form.returnCostPerUnitKrw)
      }),
    onSuccess: () => {
      setForm(initialForm);
      void queryClient.invalidateQueries({ queryKey: ["coupang-product-settings"] });
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
  const updateProductGroup = useMutation({
    mutationFn: ({ productId, groupId }: { productId: string; groupId: string }) =>
      apiPatch(`/coupang/product-settings/${productId}`, { groupId: groupId || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["coupang-product-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["coupang-product-groups"] });
    }
  });

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>쿠팡 상품 설정</h1>
          <p>쿠팡 상품 매칭과 판매가, 원가, 비용 기준을 관리합니다.</p>
        </div>
      </div>

      <div className="panel">
        <h2>새 쿠팡 상품</h2>
        <div className="form-grid">
          <input className="input" placeholder="상품명" value={form.displayName} onChange={(event) => setValue("displayName", event.target.value, setForm)} />
          <select className="input" value={form.groupId} onChange={(event) => setValue("groupId", event.target.value, setForm)}>
            <option value="">제품그룹 없음</option>
            {(groups.data ?? []).map((group) => (
              <option key={group.id} value={group.id}>
                {group.displayName}
              </option>
            ))}
          </select>
          <input className="input" placeholder="판매가(원)" value={form.salePriceKrw} onChange={(event) => setValue("salePriceKrw", event.target.value, setForm)} />
          <input className="input" placeholder="상품 원가(원)" value={form.productCostKrw} onChange={(event) => setValue("productCostKrw", event.target.value, setForm)} />
          <input className="input" placeholder="판매 수수료(원)" value={form.salesFeeKrw} onChange={(event) => setValue("salesFeeKrw", event.target.value, setForm)} />
          <input className="input" placeholder="판매자 배송비(원)" value={form.sellerShippingFeeKrw} onChange={(event) => setValue("sellerShippingFeeKrw", event.target.value, setForm)} />
          <input className="input" placeholder="그로스 입출고비(원)" value={form.growthInboundFeeKrw} onChange={(event) => setValue("growthInboundFeeKrw", event.target.value, setForm)} />
          <input className="input" placeholder="그로스 배송비(원)" value={form.growthShippingFeeKrw} onChange={(event) => setValue("growthShippingFeeKrw", event.target.value, setForm)} />
          <input className="input" placeholder="반품률 예: 0.08" value={form.returnRate} onChange={(event) => setValue("returnRate", event.target.value, setForm)} />
          <input className="input" placeholder="반품 1건당 비용(원)" value={form.returnCostPerUnitKrw} onChange={(event) => setValue("returnCostPerUnitKrw", event.target.value, setForm)} />
          <button className="button primary" type="button" disabled={!form.displayName || save.isPending} onClick={() => save.mutate()}>
            <Save size={16} />
            저장
          </button>
          {save.isError ? <span style={{ color: "#b42318" }}>{save.error.message}</span> : null}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="toolbar">
          <h2>제품그룹</h2>
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

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>설정 목록</h2>
        <DataTable
          rows={products.data ?? []}
          empty="등록된 쿠팡 상품이 없습니다."
          columns={[
            { key: "name", header: "상품", render: (row) => row.displayName },
            {
              key: "group",
              header: "제품그룹",
              render: (row) => (
                <select
                  className="input"
                  value={row.groupId ?? ""}
                  disabled={updateProductGroup.isPending}
                  onChange={(event) => updateProductGroup.mutate({ productId: row.id, groupId: event.target.value })}
                >
                  <option value="">없음</option>
                  {(groups.data ?? []).map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.displayName}
                    </option>
                  ))}
                </select>
              )
            },
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
            { key: "active", header: "상태", render: (row) => (row.isActive ? "활성" : "비활성") }
          ]}
        />
      </div>
    </section>
  );
}

function setValue(key: keyof ProductForm, value: string, setForm: (updater: (form: ProductForm) => ProductForm) => void) {
  setForm((form) => ({ ...form, [key]: value }));
}

function numberOrUndefined(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : undefined;
}

function money(value: string | number | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number !== 0 ? `${Math.round(number).toLocaleString("ko-KR")}원` : "-";
}

function rate(value: string | number | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number !== 0 ? `${(number * 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%` : "-";
}

function formatDate(value: string | undefined) {
  return value ? value.slice(0, 10) : "-";
}
