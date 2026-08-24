import type { Permission } from "@/features/auth/auth-types";

export type BusinessMutationInventoryEntry = {
  id: string;
  source: string;
  surface: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  permission: Permission;
  readOnlyReplacement: string;
  active: boolean;
  evidence: string;
  gateSource: string;
  gateEvidence: string;
};

const page = (path: string) => `app/${path}/page.tsx`;

export const BUSINESS_MUTATION_INVENTORY: readonly BusinessMutationInventoryEntry[] = [
  entry("dashboard.run-decision", page("dashboard"), "runDecision button", "POST", "/decisions/run", "operations.run", "기존 판정 결과", "apiPost(\"/decisions/run\"", "useCan(\"operations.run\")"),

  entry("uploads.meta-upload", page("uploads"), "Meta upload form", "POST", "/uploads/meta-ad-daily-csv", "imports.manage", "Meta 배치 이력과 검증 정책", "uploadCsv(file", "useCan(\"imports.manage\")"),
  entry("uploads.cafe24-upload", page("uploads"), "Cafe24 upload form", "POST", "/sales/cafe24/uploads", "imports.manage", "Cafe24 배치 이력과 쿠폰 검증 결과", "uploadCafe24Csv(cafe24File", "useCan(\"imports.manage\")"),
  entry("uploads.meta-delete", page("uploads"), "Meta history action column", "DELETE", "/uploads/:id", "imports.manage", "action 열 없는 Meta 배치 이력", "apiDelete(`/uploads/${id}`)", "useCan(\"imports.manage\")"),
  entry("uploads.cafe24-delete", page("uploads"), "Cafe24 history action column", "DELETE", "/sales/cafe24/uploads/:id", "imports.manage", "action 열 없는 Cafe24 배치 이력", "apiDelete(`/sales/cafe24/uploads/${id}`)", "useCan(\"imports.manage\")"),

  entry("sales.cafe24-rematch", page("sales"), "rematch button", "POST", "/sales/cafe24/rematch", "mappings.manage", "판매 조회·필터·클라이언트 XLSX", "apiPost(`/sales/cafe24/rematch?${query}`", "useCan(\"mappings.manage\")"),

  entry("mappings.product-rule-create", page("mappings"), "product rule form", "POST", "/mappings/product-rules", "mappings.manage", "저장된 제품 규칙 목록", "apiPost(\"/mappings/product-rules\"", "useCan(\"mappings.manage\")"),
  entry("mappings.cafe24-rule-create", page("mappings"), "Cafe24 rule create form", "POST", "/sales/cafe24/rules", "mappings.manage", "Cafe24 규칙 read-only detail", "apiPost(\"/sales/cafe24/rules\"", "useCan(\"mappings.manage\")"),
  entry("mappings.cafe24-rule-update", page("mappings"), "Cafe24 saved rule form", "PATCH", "/sales/cafe24/rules/:id", "mappings.manage", "Cafe24 규칙 read-only detail", "apiPatch(`/sales/cafe24/rules/${id}`", "useCan(\"mappings.manage\")"),
  entry("mappings.cafe24-rule-delete", page("mappings"), "Cafe24 delete button", "DELETE", "/sales/cafe24/rules/:id", "mappings.manage", "삭제 버튼 없는 규칙 detail", "apiDelete(`/sales/cafe24/rules/${id}`", "useCan(\"mappings.manage\")"),
  entry("mappings.manual-product", page("mappings"), "manual product mapping form", "POST", "/mappings/product/manual", "mappings.manage", "미매칭 및 규칙 조회", "apiPost(\"/mappings/product/manual\"", "useCan(\"mappings.manage\")"),
  entry("mappings.manual-stage", page("mappings"), "manual stage mapping form", "POST", "/mappings/stage/manual", "mappings.manage", "미매칭 및 규칙 조회", "apiPost(\"/mappings/stage/manual\"", "useCan(\"mappings.manage\")"),
  entry("mappings.rematch", page("mappings"), "auto rematch button", "POST", "/mappings/rematch", "mappings.manage", "미매칭 결과 조회", "apiPost<{ scannedCount", "useCan(\"mappings.manage\")"),

  entry("change-logs.product-log-create", page("change-logs"), "new log form", "POST", "/change-logs/products/:id/logs", "change_logs.create", "제품 상태·광고 상태·기존 timeline", "apiPost(`/change-logs/products/${selectedProductId}/logs`", "useCan(\"change_logs.create\")"),

  entry("coupang-mappings.rule-create", page("coupang/mappings"), "mapping rule form", "POST", "/coupang/mapping-rules", "mappings.manage", "저장 규칙과 mapping issue", "apiPost<CoupangMappingRule>(\"/coupang/mapping-rules\"", "useCan(\"mappings.manage\")"),
  entry("coupang-mappings.rule-update", page("coupang/mappings"), "mapping edit form", "PATCH", "/coupang/mapping-rules/:id", "mappings.manage", "action 열 없는 저장 규칙", "apiPatch<CoupangMappingRule>(`/coupang/mapping-rules/${id}`", "useCan(\"mappings.manage\")"),
  entry("coupang-mappings.rule-disable", page("coupang/mappings"), "saved rule action column", "DELETE", "/coupang/mapping-rules/:id", "mappings.manage", "action 열 없는 저장 규칙", "apiDelete<CoupangMappingRule>(`/coupang/mapping-rules/${id}`", "useCan(\"mappings.manage\")"),
  entry("coupang-mappings.rematch", page("coupang/mappings"), "rematch button", "POST", "/coupang/rematch", "mappings.manage", "issue filters와 저장 규칙", "apiPost(`/coupang/rematch?${rangeQuery(range)}`", "useCan(\"mappings.manage\")"),
  entry("coupang-unmatched.rematch", page("coupang/unmatched"), "rematch button", "POST", "/coupang/rematch", "mappings.manage", "미매칭 table", "apiPost(`/coupang/rematch?${rangeQuery(range)}`", "useCan(\"mappings.manage\")"),

  entry("coupang-uploads.sales", page("coupang/uploads"), "sales XLSX form", "POST", "/coupang/uploads/sales", "imports.manage", "Coupang 배치 이력", "uploadCoupangSalesXlsx(salesFile", "useCan(\"imports.manage\")"),
  entry("coupang-uploads.ads", page("coupang/uploads"), "ads XLSX form", "POST", "/coupang/uploads/ads", "imports.manage", "Coupang 배치 이력", "uploadCoupangAdsXlsx(adsFile", "useCan(\"imports.manage\")"),
  entry("coupang-uploads.margin", page("coupang/uploads"), "margin CSV form", "POST", "/coupang/uploads/margin", "imports.manage", "Coupang 배치 이력", "uploadCoupangMarginCsv(marginFile", "useCan(\"imports.manage\")"),
  entry("coupang-uploads.promotion", page("coupang/uploads"), "promotion XLSX form", "POST", "/coupang/uploads/promotion", "imports.manage", "Coupang 배치 이력", "uploadCoupangPromotionXlsx(promotionFile", "useCan(\"imports.manage\")"),
  entry("coupang-uploads.delete", page("coupang/uploads"), "batch action column", "DELETE", "/coupang/uploads/:id", "imports.manage", "action 열 없는 배치 이력", "apiDelete(`/coupang/uploads/${id}`", "useCan(\"imports.manage\")"),
  entry("coupang-uploads.manual-purchases", page("coupang/uploads"), "manual purchase editor", "PUT", "/coupang/manual-purchases/:date", "operations.run", "날짜·그룹·검색 및 현재 수량 table", "apiPut<CoupangManualPurchaseSaveResponse>(`/coupang/manual-purchases/${manualDate}`", "useCan(\"operations.run\")"),
  entry("coupang-uploads.vendor-fee", page("coupang/uploads"), "vendor fee form", "PATCH", "/settings/products/coupang-manual-purchase-vendor-fee", "products.manage", "현재 건당 수수료", "apiPatch(\"/settings/products/coupang-manual-purchase-vendor-fee\"", "useCan(\"products.manage\")"),

  entry("coupang-products.sales-fee-create", page("coupang/products"), "sales fee form", "POST", "/coupang/sales-fee-rules", "products.manage", "현재 수수료와 변경 이력", "apiPost<{ rule: CoupangSalesFeeRule }>(\"/coupang/sales-fee-rules\"", "useCan(\"products.manage\")"),
  entry("coupang-products.sales-fee-correct", page("coupang/products"), "sales fee history correction", "PATCH", "/coupang/sales-fee-rules/:id", "products.manage", "관리 열 없는 수수료 이력", "apiPatch<{ rule: CoupangSalesFeeRule }>(`/coupang/sales-fee-rules/${correctingGlobalRuleId}`", "useCan(\"products.manage\")"),
  entry("coupang-products.cost-correct", page("coupang/products"), "cost history correction", "PATCH", "/coupang/product-settings/:id/cost-rules/:ruleId", "products.manage", "action 없는 비용 이력", "apiPatch<CoupangCostRule>(", "useCan(\"products.manage\")"),
  entry("coupang-products.configuration-update", page("coupang/products"), "product detail editor", "PATCH", "/coupang/product-settings/:id/configuration", "products.manage", "행 선택 기반 read-only detail", "`/coupang/product-settings/${editingProductId}/configuration`", "useCan(\"products.manage\")"),
  entry("coupang-products.product-create", page("coupang/products"), "new product form", "POST", "/coupang/product-settings", "products.manage", "설정 목록과 read-only detail", "apiPost<CoupangProductSetting>(\"/coupang/product-settings\"", "useCan(\"products.manage\")"),
  entry("coupang-products.group-create", page("coupang/products"), "group create form", "POST", "/coupang/product-groups", "products.manage", "제품그룹 목록", "apiPost(\"/coupang/product-groups\"", "useCan(\"products.manage\")"),
  entry("coupang-products.group-disable", page("coupang/products"), "group action column", "DELETE", "/coupang/product-groups/:id", "products.manage", "action 열 없는 제품그룹 목록", "apiDelete(`/coupang/product-groups/${id}`", "useCan(\"products.manage\")"),

  categoryEntry("daily-category.create", "category create form", "POST", "/coupang/daily-report/categories", "apiPost<CoupangDailyReportCategory>(\"/coupang/daily-report/categories\""),
  categoryEntry("daily-category.products-update", "category member editor", "PUT", "/coupang/daily-report/categories/:id/products", "apiPut<CoupangDailyReportCategory>("),
  categoryEntry("daily-category.deactivate", "category deactivate button", "DELETE", "/coupang/daily-report/categories/:id", "apiDelete<CoupangDailyReportCategory>("),
  categoryEntry("daily-category.reactivate", "category reactivate button", "PATCH", "/coupang/daily-report/categories/:id", "apiPatch<CoupangDailyReportCategory>("),

  entry("product-settings.product-create", page("settings/products"), "product create form", "POST", "/products", "products.manage", "제품 목록", "apiPost(\"/products\"", "useCan(\"products.manage\")"),
  entry("product-settings.product-delete", page("settings/products"), "product action column", "DELETE", "/products/:id", "products.manage", "action 열 없는 제품 목록", "apiDelete(`/products/${id}`", "useCan(\"products.manage\")"),
  entry("product-settings.cost-create", page("settings/products"), "cost snapshot form", "POST", "/products/:id/cost-rules", "products.manage", "현재 비용과 원가 이력", "apiPost(metaProductCostSnapshotPath(productId)", "useCan(\"products.manage\")"),
  entry("product-settings.cost-correct", page("settings/products"), "cost correction form", "PATCH", "/products/:id/cost-rules/:ruleId", "products.manage", "관리 열 없는 원가 이력", "apiPatch(metaProductCostCorrectionPath(productId, ruleId)", "useCan(\"products.manage\")"),
  entry("product-settings.cpa-create", page("settings/products"), "CPA snapshot form", "POST", "/products/:id/cpa-rules", "products.manage", "현재 CPA와 CPA 이력", "apiPost(metaProductCpaSnapshotPath(productId)", "useCan(\"products.manage\")"),
  entry("product-settings.cpa-correct", page("settings/products"), "CPA correction form", "PATCH", "/products/:id/cpa-rules/:ruleId", "products.manage", "관리 열 없는 CPA 이력", "apiPatch(metaProductCpaCorrectionPath(productId, ruleId)", "useCan(\"products.manage\")"),
  entry("product-settings.coupon-create", page("settings/products"), "coupon create form", "POST", "/sales/cafe24/coupon-rules", "products.manage", "저장된 쿠폰 규칙", "apiPost<Cafe24CouponRule>(\"/sales/cafe24/coupon-rules\"", "useCan(\"products.manage\")"),
  entry("product-settings.coupon-update", page("settings/products"), "coupon edit/deactivate handler", "PATCH", "/sales/cafe24/coupon-rules/:id", "products.manage", "edit/deactivate 열 없는 쿠폰 규칙", "apiPatch<Cafe24CouponRule>(`/sales/cafe24/coupon-rules/${id}`", "useCan(\"products.manage\")"),

  inactive("inactive.upload-dropzone", "components/UploadDropzone.tsx", "UploadDropzone", "POST", "/uploads/meta-ad-daily-csv", "imports.manage", "uploadCsv(file"),
  inactive("inactive.report-export", "components/ReportExportButton.tsx", "ReportExportButton", "POST", "/reports/export", "reports.generate", "apiPost(\"/reports/export\""),
  inactive("inactive.product-rule-editor", "components/ProductRuleEditor.tsx", "ProductRuleEditor", "POST", "/mappings/product-rules", "mappings.manage", "apiPost(\"/mappings/product-rules\""),
  inactive("inactive.manual-product", "components/ManualMappingEditor.tsx", "ManualMappingEditor product", "POST", "/mappings/product/manual", "mappings.manage", "apiPost(\"/mappings/product/manual\""),
  inactive("inactive.manual-stage", "components/ManualMappingEditor.tsx", "ManualMappingEditor stage", "POST", "/mappings/stage/manual", "mappings.manage", "apiPost(\"/mappings/stage/manual\"")
] as const;

export function visibleBusinessMutations(permissions: readonly Permission[]) {
  const granted = new Set(permissions);
  return BUSINESS_MUTATION_INVENTORY.filter((item) => item.active && granted.has(item.permission));
}

function entry(
  id: string,
  source: string,
  surface: string,
  method: BusinessMutationInventoryEntry["method"],
  path: string,
  permission: Permission,
  readOnlyReplacement: string,
  evidence: string,
  gateEvidence: string
): BusinessMutationInventoryEntry {
  return { id, source, surface, method, path, permission, readOnlyReplacement, active: true, evidence, gateSource: source, gateEvidence };
}

function categoryEntry(
  id: string,
  surface: string,
  method: BusinessMutationInventoryEntry["method"],
  path: string,
  evidence: string
): BusinessMutationInventoryEntry {
  return {
    id,
    source: "app/coupang/daily-report/category-manager.tsx",
    surface,
    method,
    path,
    permission: "products.manage",
    readOnlyReplacement: "카테고리 필터와 report 조회; 첫 category 생성과 관리자 dialog 제거",
    active: true,
    evidence,
    gateSource: page("coupang/daily-report"),
    gateEvidence: "useCan(\"products.manage\")"
  };
}

function inactive(
  id: string,
  source: string,
  surface: string,
  method: BusinessMutationInventoryEntry["method"],
  path: string,
  permission: Permission,
  evidence: string
): BusinessMutationInventoryEntry {
  return {
    id,
    source,
    surface,
    method,
    path,
    permission,
    readOnlyReplacement: "현재 활성 import graph에 없음; 재활성화 시 PermissionGate 계약 필요",
    active: false,
    evidence,
    gateSource: source,
    gateEvidence: "inactive"
  };
}
