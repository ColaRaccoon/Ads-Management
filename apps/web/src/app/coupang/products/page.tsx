"use client";

import { Save } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { DataTable } from "@/components/data-table";

type CoupangProductSetting = {
  id: string;
  standardName: string;
  displayName: string;
  sortOrder: number;
  isActive: boolean;
  productRules: Array<{
    displayName: string;
    includeKeywords: unknown;
    excludeKeywords: unknown;
    priority: number;
    saleMethod?: string | null;
    adEnabled: boolean;
  }>;
  costRules: Array<{
    salePriceKrw: string | number;
    productCostKrw: string | number;
    salesFeeRate: string | number;
    salesFeeKrw: string | number;
    sellerShippingFeeKrw: string | number;
    growthInboundFeeKrw: string | number;
    growthShippingFeeKrw: string | number;
    returnRate: string | number;
    returnCostPerUnitKrw: string | number;
    effectiveFrom: string;
  }>;
};

type ProductForm = {
  displayName: string;
  includeKeywords: string;
  excludeKeywords: string;
  priority: string;
  saleMethod: string;
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
  includeKeywords: "",
  excludeKeywords: "",
  priority: "100",
  saleMethod: "",
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
  const queryClient = useQueryClient();
  const products = useQuery({
    queryKey: ["coupang-product-settings"],
    queryFn: () => apiGet<CoupangProductSetting[]>("/coupang/product-settings")
  });
  const save = useMutation({
    mutationFn: () =>
      apiPost("/coupang/product-settings", {
        displayName: form.displayName,
        standardName: form.displayName,
        includeKeywords: commaList(form.includeKeywords || form.displayName),
        excludeKeywords: commaList(form.excludeKeywords),
        priority: Number(form.priority || 100),
        saleMethod: form.saleMethod,
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

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Coupang Product Settings</h1>
          <p>Manage Coupang-only product matching and cost rules.</p>
        </div>
      </div>

      <div className="panel">
        <h2>New Coupang Product</h2>
        <div className="form-grid">
          <input className="input" placeholder="Product name" value={form.displayName} onChange={(event) => setValue("displayName", event.target.value, setForm)} />
          <input className="input" placeholder="Include keywords, comma separated" value={form.includeKeywords} onChange={(event) => setValue("includeKeywords", event.target.value, setForm)} />
          <input className="input" placeholder="Exclude keywords, comma separated" value={form.excludeKeywords} onChange={(event) => setValue("excludeKeywords", event.target.value, setForm)} />
          <input className="input" placeholder="Priority" value={form.priority} onChange={(event) => setValue("priority", event.target.value, setForm)} />
          <input className="input" placeholder="Sale method" value={form.saleMethod} onChange={(event) => setValue("saleMethod", event.target.value, setForm)} />
          <input className="input" placeholder="Sale price KRW" value={form.salePriceKrw} onChange={(event) => setValue("salePriceKrw", event.target.value, setForm)} />
          <input className="input" placeholder="Product cost KRW" value={form.productCostKrw} onChange={(event) => setValue("productCostKrw", event.target.value, setForm)} />
          <input className="input" placeholder="Sales fee KRW" value={form.salesFeeKrw} onChange={(event) => setValue("salesFeeKrw", event.target.value, setForm)} />
          <input className="input" placeholder="Seller shipping KRW" value={form.sellerShippingFeeKrw} onChange={(event) => setValue("sellerShippingFeeKrw", event.target.value, setForm)} />
          <input className="input" placeholder="Growth inbound KRW" value={form.growthInboundFeeKrw} onChange={(event) => setValue("growthInboundFeeKrw", event.target.value, setForm)} />
          <input className="input" placeholder="Growth shipping KRW" value={form.growthShippingFeeKrw} onChange={(event) => setValue("growthShippingFeeKrw", event.target.value, setForm)} />
          <input className="input" placeholder="Return rate e.g. 0.08" value={form.returnRate} onChange={(event) => setValue("returnRate", event.target.value, setForm)} />
          <input className="input" placeholder="Return cost per unit KRW" value={form.returnCostPerUnitKrw} onChange={(event) => setValue("returnCostPerUnitKrw", event.target.value, setForm)} />
          <button className="button primary" type="button" disabled={!form.displayName || save.isPending} onClick={() => save.mutate()}>
            <Save size={16} />
            Save
          </button>
          {save.isError ? <span style={{ color: "#b42318" }}>{save.error.message}</span> : null}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>Settings</h2>
        <DataTable
          rows={products.data ?? []}
          columns={[
            { key: "name", header: "Product", render: (row) => row.displayName },
            { key: "include", header: "Include", render: (row) => jsonList(row.productRules[0]?.includeKeywords) },
            { key: "exclude", header: "Exclude", render: (row) => jsonList(row.productRules[0]?.excludeKeywords) },
            { key: "priority", header: "Priority", render: (row) => row.productRules[0]?.priority ?? "-" },
            { key: "price", header: "Sale Price", render: (row) => money(row.costRules[0]?.salePriceKrw) },
            { key: "cost", header: "Product Cost", render: (row) => money(row.costRules[0]?.productCostKrw) },
            { key: "return", header: "Return Cost", render: (row) => money(row.costRules[0]?.returnCostPerUnitKrw) },
            { key: "active", header: "Active", render: (row) => (row.isActive ? "Y" : "N") }
          ]}
        />
      </div>
    </section>
  );
}

function setValue(key: keyof ProductForm, value: string, setForm: (updater: (form: ProductForm) => ProductForm) => void) {
  setForm((form) => ({ ...form, [key]: value }));
}

function commaList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberOrUndefined(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : undefined;
}

function money(value: string | number | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number !== 0 ? `${Math.round(number).toLocaleString("ko-KR")}원` : "-";
}

function jsonList(value: unknown) {
  return Array.isArray(value) ? value.join(", ") : "-";
}
